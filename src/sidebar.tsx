import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { terminalText } from "./guide.ts";
import type { GuideStore } from "./store.ts";
import { flushPromptCopy } from "./prompt.ts";

export function createSidebar(store: GuideStore) {
  return function GuidedReviewSidebar({ files, selectedFileId, theme, actions }: ExtensionPaneProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    const visible = new Map(files.map((file) => [file.path, file]));
    const selectedPath = files.find((file) => file.id === selectedFileId)?.path;
    const activeSection = state.guide?.sections.find((section) => section.files.includes(selectedPath ?? ""));

    useEffect(() => { flushPromptCopy(store, actions); }, [state.pendingCopy, actions]);
        useEffect(() => { setCollapsed(new Set()); }, [state.guide]);
    useEffect(() => {
      if (activeSection) scroll.current?.scrollChildIntoView(`section-${activeSection.id}`);
    }, [activeSection?.id]);

    const toggle = (id: string) => setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

    return (
      <scrollbox ref={scroll} width="100%" height="100%" scrollY={true} focused={false}>
        <box width="100%" flexDirection="column" padding={1} gap={1}>
          <text content="Guided review" fg={theme.accent} />
          <text content="AI-organized · verify against the diff" fg={theme.muted} />
          <text content="Extensions → Copy review prompt" fg={theme.muted} />
          {!state.guide ? (
            <box flexDirection="column" gap={1}>
              <text content={terminalText(state.message)} fg={theme.text} />
              <text content="Use Extensions → Copy review prompt and paste it into your agent. Your agent reads the live Hunk session; use Reload review guide when it is ready." fg={theme.muted} />
              <text content={`Guide: ${terminalText(state.guidePath)}`} fg={theme.muted} />
            </box>
          ) : (
            <>
              <text content={terminalText(state.guide.summary)} fg={theme.text} />
              {state.guide.sections.map((section, index) => {
                const active = section.id === activeSection?.id;
                const firstVisible = section.files.map((path) => visible.get(path)).find(Boolean);
                const visibleCount = section.files.filter((path) => visible.has(path)).length;
                const closed = collapsed.has(section.id);
                return (
                  <box key={section.id} id={`section-${section.id}`} width="100%" flexDirection="column" gap={1}>
                    <box width="100%" flexDirection="row">
                      <text content={closed ? "+ " : "− "} fg={theme.accent} onMouseUp={() => toggle(section.id)} />
                      <text
                        content={`${index + 1}. ${terminalText(section.title)} (${visibleCount}/${section.files.length})`}
                        fg={active ? theme.accent : theme.text}
                        onMouseUp={() => {
                          if (firstVisible) actions.selectFile(firstVisible.id);
                          else actions.notify("All files in this section are hidden by the current filter", "warning");
                        }}
                      />
                    </box>
                    {!closed && (
                      <box width="100%" flexDirection="column" paddingLeft={2} gap={1}>
                        <text content={terminalText(section.summary)} fg={active ? theme.text : theme.muted} />
                        {section.files.map((path) => {
                          const file = visible.get(path);
                          return (
                            <text key={path}
                              content={`${file?.id === selectedFileId ? "›" : " "} ${terminalText(path)}${file ? `  +${file.stats.additions} −${file.stats.deletions}` : " (filtered)"}`}
                              fg={!file ? theme.muted : file.id === selectedFileId ? theme.accent : theme.text}
                              onMouseUp={() => { if (file) actions.selectFile(file.id); }}
                            />
                          );
                        })}
                      </box>
                    )}
                  </box>
                );
              })}
            </>
          )}
        </box>
      </scrollbox>
    );
  };
}
