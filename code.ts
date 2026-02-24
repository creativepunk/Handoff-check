figma.showUI(__html__, { width: 400, height: 600 });

function isFrameLike(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET" || node.type === "SECTION";
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => {
    const hex = Math.round(c * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

figma.ui.onmessage = async (msg) => {
  const selection = figma.currentPage.selection;
  console.log('[BACKEND] Received:', msg.type, msg.subtab);

  const sendError = (errorMsg: string) => {
    console.error('[BACKEND] Error:', errorMsg);
    figma.ui.postMessage({ type: 'check-error', message: errorMsg });
  }

  try {
    if (msg.type === 'select-node') {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (node && (node.type !== "PAGE" && node.type !== "DOCUMENT")) {
        figma.currentPage.selection = [node as SceneNode];
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      }
      return;
    }

    if (msg.type === 'select-nodes') {
      const nodes: SceneNode[] = [];
      for (const id of msg.nodeIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && (node.type !== "PAGE" && node.type !== "DOCUMENT")) {
          nodes.push(node as SceneNode);
        }
      }
      if (nodes.length > 0) {
        figma.currentPage.selection = nodes;
        figma.viewport.scrollAndZoomIntoView(nodes);
      }
      return;
    }

    if (selection.length === 0 && (msg.type === 'run-naming-check' || msg.type === 'run-styles-check')) {
      figma.ui.postMessage({ type: 'empty-selection' });
      return;
    }

    if (msg.type === 'run-naming-check') {
      let allNodes: SceneNode[] = [];
      const visited = new Set<string>();
      const collectAll = (nodes: readonly SceneNode[]) => {
        for (const node of nodes) {
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          allNodes.push(node);
          if ("children" in node) try { collectAll((node as any).children); } catch (e) { }
        }
      };
      collectAll(selection);

      const unnamed = allNodes.filter(n => /^Frame \d+$/.test(n.name) || /^Rectangle \d+$/.test(n.name) || /^Ellipse \d+$/.test(n.name) || /^Vector \d+$/.test(n.name) || /^Group \d+$/.test(n.name));
      const named = allNodes.filter(n => unnamed.indexOf(n) === -1);

      figma.ui.postMessage({
        type: 'naming-results',
        total: allNodes.length,
        unnamed: unnamed.length,
        unnamedNodes: unnamed.map(n => ({ id: n.id, name: n.name, type: n.type })),
        namedNodes: named.map(n => ({ id: n.id, name: n.name, type: n.type }))
      });
    }

    if (msg.type === 'run-styles-check') {
      if (msg.subtab === 'color') {
        console.log('--- [BACKEND] STARTING COLOR CHECK ---');
        let remote = 0, localCount = 0, unlinked = 0, totalAnalyzedCount = 0;

        type ColorNodeInfo = { id: string, name: string, type: SceneNode['type'], colors: { type: 'fill' | 'stroke', hex: string, style?: string }[] };
        const unlinkedNodes: ColorNodeInfo[] = [];
        const remoteNodes: ColorNodeInfo[] = [];
        const localNodes: ColorNodeInfo[] = [];

        const visitedNodes = new Set<string>();
        const potentialColorNodes: SceneNode[] = [];

        // Phase 1: Flatten
        const collect = (nodes: readonly SceneNode[]) => {
          for (const n of nodes) {
            if (visitedNodes.has(n.id)) continue;
            visitedNodes.add(n.id);
            if ("fills" in n || "strokes" in n) potentialColorNodes.push(n);
            if ("children" in n) try { collect((n as any).children); } catch (e) { }
          }
        };
        collect(selection);

        // Phase 3: Analyze
        for (const node of potentialColorNodes) {
          try {
            let nodeIsRemote = false, nodeIsLocal = false, nodeIsUnlinked = false;
            let nodeColors: { type: 'fill' | 'stroke', hex: string, style?: string, status: 'unlinked' | 'remote' | 'local' }[] = [];

            const processColorItem = async (paint: Paint, pType: 'fill' | 'stroke', styleId: string | typeof figma.mixed, boundVars: any) => {
              if (paint.type !== 'SOLID' && !paint.type.includes('GRADIENT')) return;
              totalAnalyzedCount++;

              let hex = paint.type === 'SOLID' ? rgbToHex(paint.color.r, paint.color.g, paint.color.b) : 'GRADIENT';
              let found = false;
              let styleName = '';
              let status: 'unlinked' | 'remote' | 'local' = 'unlinked';

              // Variables check
              if (boundVars) {
                if (boundVars.id) {
                  try {
                    const v = await figma.variables.getVariableByIdAsync(boundVars.id);
                    if (v) {
                      status = v.remote ? 'remote' : 'local';
                      styleName = v.name;
                      found = true;
                    }
                  } catch (e) { }
                }
              }

              if (!found && styleId && styleId !== '' && styleId !== figma.mixed) {
                const s = figma.getStyleById(styleId as string);
                if (s) {
                  status = s.remote ? 'remote' : 'local';
                  styleName = s.name;
                  found = true;
                } else {
                  status = 'remote'; // assume remote if style exists but not found
                  found = true;
                }
              }

              if (!found) { unlinked++; nodeIsUnlinked = true; status = 'unlinked'; }
              else if (status === 'remote') { remote++; nodeIsRemote = true; }
              else { localCount++; nodeIsLocal = true; }

              nodeColors.push({ type: pType, hex, style: styleName, status });
            };

            // Fills
            if ("fills" in node) {
              const fills = (node as any).fills;
              if (fills === figma.mixed) {
                totalAnalyzedCount++; unlinked++; nodeIsUnlinked = true;
                nodeColors.push({ type: 'fill', hex: 'MIXED', status: 'unlinked' });
              } else if (Array.isArray(fills)) {
                for (let i = 0; i < fills.length; i++) {
                  const bound = node.boundVariables && node.boundVariables.fills ? (Array.isArray(node.boundVariables.fills) ? node.boundVariables.fills[i] : node.boundVariables.fills) : null;
                  await processColorItem(fills[i], 'fill', (node as any).fillStyleId, bound);
                }
              }
            }

            // Strokes
            if ("strokes" in node) {
              const strokes = (node as any).strokes;
              if (strokes === figma.mixed) {
                totalAnalyzedCount++; unlinked++; nodeIsUnlinked = true;
                nodeColors.push({ type: 'stroke', hex: 'MIXED', status: 'unlinked' });
              } else if (Array.isArray(strokes)) {
                for (let i = 0; i < strokes.length; i++) {
                  const bound = node.boundVariables && node.boundVariables.strokes ? (Array.isArray(node.boundVariables.strokes) ? node.boundVariables.strokes[i] : node.boundVariables.strokes) : null;
                  await processColorItem(strokes[i], 'stroke', (node as any).strokeStyleId, bound);
                }
              }
            }

            const info: ColorNodeInfo = { id: node.id, name: node.name, type: node.type, colors: [] };
            if (nodeIsUnlinked) unlinkedNodes.push({ ...info, colors: nodeColors.filter(c => c.status === 'unlinked') });
            if (nodeIsRemote) remoteNodes.push({ ...info, colors: nodeColors.filter(c => c.status === 'remote') });
            if (nodeIsLocal) localNodes.push({ ...info, colors: nodeColors.filter(c => c.status === 'local') });

          } catch (e) { }
        }

        figma.ui.postMessage({
          type: 'color-results',
          total: totalAnalyzedCount,
          remote,
          local: localCount,
          unlinked,
          unlinkedNodes,
          remoteNodes,
          localNodes
        });
      }

      if (msg.subtab === 'text') {
        let remote = 0, localCountValue = 0, unlinkedCountValue = 0, totalAnalyzedCountValue = 0;
        const textNodes: TextNode[] = [];
        const visited = new Set<string>();

        type TextNodeInfo = { id: string, name: string, type: 'TEXT' };
        const unlinkedNodes: TextNodeInfo[] = [];
        const remoteNodes: TextNodeInfo[] = [];
        const localNodes: TextNodeInfo[] = [];

        const collect = (nodes: readonly SceneNode[]) => {
          for (const n of nodes) {
            if (visited.has(n.id)) continue;
            visited.add(n.id);
            if (n.type === "TEXT") textNodes.push(n);
            if ("children" in n) try { collect((n as any).children); } catch (e) { }
          }
        };
        collect(selection);

        // Phase 2: Registry
        const localStyleNames = new Set<string>();
        try {
          const localStyles = figma.getLocalTextStyles();
          for (const s of localStyles) { localStyleNames.add(s.name.toLowerCase()); }
        } catch (err) { }

        // Phase 3: Analyze
        for (const node of textNodes) {
          try {
            const sid = node.textStyleId;
            let nodeHasUnlinked = false, nodeHasRemote = false, nodeHasLocal = false;

            const processSid = (sidVal: string | typeof figma.mixed) => {
              totalAnalyzedCountValue++;
              if (!sidVal || typeof sidVal !== 'string' || sidVal === '') { unlinkedCountValue++; nodeHasUnlinked = true; return; }
              let style = null;
              try { style = figma.getStyleById(sidVal); } catch (e) { }
              if (style) {
                if (!style.remote || localStyleNames.has(style.name.toLowerCase())) { localCountValue++; nodeHasLocal = true; }
                else { remote++; nodeHasRemote = true; }
              } else { remote++; nodeHasRemote = true; }
            };

            if (sid === figma.mixed) {
              try {
                const segments = node.getStyledTextSegments(['textStyleId']);
                for (const seg of segments) processSid(seg.textStyleId);
              } catch (segErr) { totalAnalyzedCountValue++; unlinkedCountValue++; nodeHasUnlinked = true; }
            } else processSid(sid);

            const info: TextNodeInfo = { id: node.id, name: node.name, type: 'TEXT' };
            if (nodeHasUnlinked) unlinkedNodes.push(info);
            if (nodeHasRemote) remoteNodes.push(info);
            if (nodeHasLocal) localNodes.push(info);
          } catch (err) { }
        }
        figma.ui.postMessage({
          type: 'text-results',
          total: totalAnalyzedCountValue,
          remote,
          local: localCountValue,
          unlinked: unlinkedCountValue,
          unlinkedNodes,
          remoteNodes,
          localNodes
        });
      }
    }
  } catch (globalErr) {
    const errMsg = globalErr instanceof Error ? globalErr.message : String(globalErr);
    sendError('General failure: ' + errMsg);
  }
};
