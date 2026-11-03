import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("Workspace paths render the full registered path safely and explain missing bindings", async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    esbuild: { jsx: "automatic" },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { default: WorkspacePath } = await server.ssrLoadModule("/src/components/WorkspacePath.tsx");
    const path = '/workspace/a long directory/<script> & "notes"';
    const markup = renderToStaticMarkup(createElement(WorkspacePath, { path }));
    assert.match(markup, /class="workspace-path"/);
    assert.ok(markup.includes('title="/workspace/a long directory/&lt;script&gt; &amp; &quot;notes&quot;"'));
    assert.match(markup, /&lt;script&gt; &amp; &quot;notes&quot;/);
    assert.doesNotMatch(markup, /<script>/);
    const missing = renderToStaticMarkup(createElement(WorkspacePath, { path: null }));
    assert.match(missing, />未绑定工作目录<\/span>/);
    assert.match(missing, /title="未绑定工作目录"/);
  } finally {
    await server.close();
  }
});

test("Projects, Tasks, Today descendants, and quick Tasks show a path before their description", async () => {
  const projects = await readFile(new URL("../src/components/ProjectsPage.tsx", import.meta.url), "utf8");
  const today = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const archive = await readFile(new URL("../src/components/ArchivePage.tsx", import.meta.url), "utf8");
  assert.match(projects, /node\.item\.title\}[\s\S]*?<WorkspacePath path=\{node\.item\.workspace_path\} \/>[\s\S]*?node\.item\.summary/);
  assert.match(today, /todayPath\(item\)[\s\S]*?<WorkspacePath path=\{item\.workspace_path\} \/>[\s\S]*?item\.summary/);
  assert.match(today, /childItemPath\(item, child\)[\s\S]*?<WorkspacePath path=\{child\.workspace_path\} \/>[\s\S]*?child\.summary/);
  assert.match(today, /className="quick-item-description">\{item\.title\}<\/span>\s*<WorkspacePath path=\{item\.workspace_path\} \/>/);
  assert.match(styles, /\.workspace-path\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  assert.doesNotMatch(archive, /WorkspacePath/);
});
