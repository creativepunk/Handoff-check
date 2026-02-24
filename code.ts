figma.showUI(__html__, { width: 400, height: 600 });

function isFrameLike(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET" || node.type === "SECTION";
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
      let allFrames: SceneNode[] = [];
      const visited = new Set<string>();
      const findFrames = (nodes: readonly SceneNode[]) => {
        for (const node of nodes) {
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          if (isFrameLike(node)) allFrames.push(node);
          if ("children" in node) try { findFrames((node as any).children); } catch (e) { }
        }
      };
      findFrames(selection);

      if (allFrames.length === 0) {
        for (const node of selection) {
          let parent = node.parent;
          while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
            if (isFrameLike(parent as any) && !visited.has(parent.id)) {
              allFrames.push(parent as any);
              visited.add(parent.id);
              break;
            }
            parent = parent.parent;
          }
        }
      }

      const unnamed = allFrames.filter(f => /^Frame \d+$/.test(f.name));
      figma.ui.postMessage({
        type: 'naming-results',
        total: allFrames.length,
        unnamed: unnamed.length,
        unnamedNodes: unnamed.map(n => ({ id: n.id, name: n.name }))
      });
    }

    if (msg.type === 'run-styles-check') {
      if (msg.subtab === 'color') {
        console.log('--- [BACKEND] STARTING COLOR CHECK ---');
        let remote = 0, localCount = 0, unlinked = 0, totalAnalyzedCount = 0;
        const unlinkedNodes: { id: string, name: string }[] = [];
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
        console.log(`[BACKEND] Phase 1: Found ${potentialColorNodes.length} nodes to analyze.`);

        // Phase 3: Analyze
        console.log('[BACKEND] Phase 3: Analyzing colors...');
        for (const node of potentialColorNodes) {
          try {
            let isUnlinkedNode = false;

            // Fills
            if ("fills" in node) {
              const fills = (node as any).fills;
              if (fills === figma.mixed) {
                totalAnalyzedCount++; unlinked++; isUnlinkedNode = true;
              } else if (Array.isArray(fills)) {
                const fillStyleId = (node as any).fillStyleId;
                for (let i = 0; i < fills.length; i++) {
                  const fill = fills[i];
                  if (fill.type === 'SOLID' || fill.type.includes('GRADIENT')) {
                    totalAnalyzedCount++;
                    let found = false;
                    // Variables check
                    if (node.boundVariables && node.boundVariables.fills) {
                      const bound = Array.isArray(node.boundVariables.fills) ? node.boundVariables.fills[i] : node.boundVariables.fills;
                      if (bound && bound.id) {
                        try {
                          const v = await figma.variables.getVariableByIdAsync(bound.id);
                          if (v) { if (v.remote) remote++; else localCount++; found = true; }
                        } catch (e) { }
                      }
                    }
                    if (found) continue;
                    // Styles check
                    if (fillStyleId && fillStyleId !== '' && fillStyleId !== figma.mixed) {
                      const s = figma.getStyleById(fillStyleId);
                      if (s) { if (s.remote) remote++; else localCount++; found = true; }
                      else { remote++; found = true; }
                    }
                    if (!found) { unlinked++; isUnlinkedNode = true; }
                  }
                }
              }
            }

            // Strokes
            if ("strokes" in node) {
              const strokes = (node as any).strokes;
              if (strokes === figma.mixed) {
                totalAnalyzedCount++; unlinked++; isUnlinkedNode = true;
              } else if (Array.isArray(strokes)) {
                const strokeStyleId = (node as any).strokeStyleId;
                for (let i = 0; i < strokes.length; i++) {
                  const stroke = strokes[i];
                  if (stroke.type === 'SOLID' || stroke.type.includes('GRADIENT')) {
                    totalAnalyzedCount++;
                    let found = false;
                    // Variables check
                    if (node.boundVariables && node.boundVariables.strokes) {
                      const bound = Array.isArray(node.boundVariables.strokes) ? node.boundVariables.strokes[i] : node.boundVariables.strokes;
                      if (bound && bound.id) {
                        try {
                          const v = await figma.variables.getVariableByIdAsync(bound.id);
                          if (v) { if (v.remote) remote++; else localCount++; found = true; }
                        } catch (e) { }
                      }
                    }
                    if (found) continue;
                    // Styles check
                    if (strokeStyleId && strokeStyleId !== '' && strokeStyleId !== figma.mixed) {
                      const s = figma.getStyleById(strokeStyleId);
                      if (s) { if (s.remote) remote++; else localCount++; found = true; }
                      else { remote++; found = true; }
                    }
                    if (!found) { unlinked++; isUnlinkedNode = true; }
                  }
                }
              }
            }

            if (isUnlinkedNode) {
              unlinkedNodes.push({ id: node.id, name: node.name });
            }
          } catch (e) { }
        }

        figma.ui.postMessage({ type: 'color-results', total: totalAnalyzedCount, remote, local: localCount, unlinked, unlinkedNodes });
        console.log('[BACKEND] Color results sent');
      }

      if (msg.subtab === 'text') {
        console.log('--- [BACKEND] STARTING TEXT CHECK ---');
        let remote = 0, localCountValue = 0, unlinkedCountValue = 0, totalAnalyzedCountValue = 0;
        const textNodes: TextNode[] = [];
        const visited = new Set<string>();
        const unlinkedNodes: { id: string, name: string }[] = [];

        const collect = (nodes: readonly SceneNode[]) => {
          for (const n of nodes) {
            if (visited.has(n.id)) continue;
            visited.add(n.id);
            if (n.type === "TEXT") textNodes.push(n);
            if ("children" in n) try { collect((n as any).children); } catch (e) { }
          }
        };
        collect(selection);
        console.log(`[BACKEND] Phase 1: Found ${textNodes.length} nodes to analyze.`);

        // Phase 2: Registry
        const localStyleIds = new Set<string>();
        const localStyleKeys = new Set<string>();
        const localStyleNames = new Set<string>();
        try {
          const localStyles = figma.getLocalTextStyles();
          for (const s of localStyles) {
            localStyleIds.add(s.id);
            localStyleKeys.add(s.key);
            localStyleNames.add(s.name.toLowerCase());
          }
        } catch (err) { }

        const isIdLocal = (sid: string): boolean => {
          if (!sid) return false;
          if (localStyleIds.has(sid) || localStyleKeys.has(sid)) return true;
          const noSPrefix = sid.startsWith('S:') ? sid.substring(2) : sid;
          if (localStyleIds.has(noSPrefix)) return true;
          const firstPart = sid.split(',')[0];
          const cleanFirstPart = firstPart.startsWith('S:') ? firstPart.substring(2) : firstPart;
          if (localStyleIds.has(cleanFirstPart) || localStyleKeys.has(cleanFirstPart)) return true;
          for (const lid of localStyleIds) {
            const clid = lid.startsWith('S:') ? lid.substring(2) : lid;
            if (sid.includes(clid)) return true;
          }
          return false;
        };

        // Phase 3: Analyze
        for (const node of textNodes) {
          try {
            const sid = node.textStyleId;
            let nodeHasUnlinked = false;
            const processSid = (sidVal: string | typeof figma.mixed) => {
              totalAnalyzedCountValue++;
              if (!sidVal || typeof sidVal !== 'string' || sidVal === '') {
                unlinkedCountValue++; nodeHasUnlinked = true; return;
              }
              let isLocal = isIdLocal(sidVal);
              if (!isLocal) {
                try {
                  const versions = [sidVal, sidVal.replace(/^S:/, ''), sidVal.split(',')[0]];
                  for (const v of versions) {
                    const style = figma.getStyleById(v);
                    if (style) {
                      if (!style.remote || localStyleNames.has(style.name.toLowerCase())) {
                        isLocal = true; break;
                      }
                    }
                  }
                } catch (e) { }
              }
              if (isLocal) localCountValue++; else remote++;
            };
            if (sid === figma.mixed) {
              try {
                const segments = node.getStyledTextSegments(['textStyleId']);
                for (const seg of segments) processSid(seg.textStyleId);
              } catch (segErr) { totalAnalyzedCountValue++; unlinkedCountValue++; nodeHasUnlinked = true; }
            } else processSid(sid);
            if (nodeHasUnlinked) unlinkedNodes.push({ id: node.id, name: node.name });
          } catch (err) { }
        }
        figma.ui.postMessage({ type: 'text-results', total: totalAnalyzedCountValue, remote, local: localCountValue, unlinked: unlinkedCountValue, unlinkedNodes });
        console.log('[BACKEND] Text results sent');
      }
    }
  } catch (globalErr) {
    const errMsg = globalErr instanceof Error ? globalErr.message : String(globalErr);
    sendError('General failure: ' + errMsg);
  }
};
