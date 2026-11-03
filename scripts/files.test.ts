import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const directory = new Function("exec", "window", `${directorySource}; return directory;`)(
  async (command: string, args: string[]) => {
    // Hidden like the app's spawns: a visible console would give PowerShell UTF-8 and hide code page bugs.
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  () => ({ platform: process.platform === "win32" ? "windows" : process.platform }),
);

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)", "O’Brien ‘quoted’ ‚low‛"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files preserves Unicode names when listing and expanding folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-unicode-"));
  try {
    const folder = "中文目录 O'Brien (测试)", file = "项目说明.txt", child = "子文件.txt";
    await mkdir(join(root, folder));
    await writeFile(join(root, file), "hello");
    await writeFile(join(root, folder, child), "hello");
    const entries = await directory(root, null);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ name: folder, dir: true });
    expect(entries).toContainEqual({ name: file, dir: false });
    expect(await directory(join(root, folder), null)).toEqual([{ name: child, dir: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files follows directory links one level at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-links-"));
  try {
    const target = join(root, "versions");
    await mkdir(target);
    for (let minor = 1; minor <= 9; minor++) {
      await mkdir(join(target, `0.${minor}.0`));
    }
    await writeFile(join(target, "0.9.0", "STORY.md"), "story preview");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "ordinary.txt"), "ordinary");
    await symlink("versions", join(root, ".kb"), "dir");
    if (process.platform === "win32") await symlink(target, join(root, "junction"), "junction");
    await symlink(join(root, "ordinary.txt"), join(root, "file-link"), "file");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    // A cycle must be listed without recursively walking it.
    await symlink(target, join(target, "loop"), "dir");

    const entries = await directory(root, null);
    expect(entries).toHaveLength(process.platform === "win32" ? 7 : 6);
    if (process.platform === "win32") expect(entries).toContainEqual({ name: "junction", dir: true });
    expect(entries).toContainEqual({ name: ".kb", dir: true });
    expect(entries).toContainEqual({ name: "versions", dir: true });
    expect(entries).toContainEqual({ name: ".hidden", dir: true });
    expect(entries).toContainEqual({ name: "ordinary.txt", dir: false });
    expect(entries).toContainEqual({ name: "file-link", dir: false });
    expect(entries).toContainEqual({ name: "dangling", dir: false });
    const versions = await directory(join(root, ".kb"), null);
    expect(versions).toHaveLength(10);
    for (let minor = 1; minor <= 9; minor++) {
      expect(versions).toContainEqual({ name: `0.${minor}.0`, dir: true });
    }
    expect(versions).toContainEqual({ name: "loop", dir: true });
    expect(await directory(join(root, ".kb", "0.9.0"), null)).toEqual([{ name: "STORY.md", dir: false }]);
    expect(await readFile(join(root, ".kb", "0.9.0", "STORY.md"), "utf8")).toBe("story preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const kindsSource = source.slice(source.indexOf("// File kinds:"), source.indexOf("async function directory("));
const fileKind = new Function(`${kindsSource}; return fileKind;`)();

test("Files picks language and line comment by file name", () => {
  expect(fileKind(".env")).toEqual({ language: "env", comment: "#" });
  expect(fileKind("config/.env.local")).toEqual({ language: "env", comment: "#" });
  expect(fileKind("prod.env")).toEqual({ language: "env", comment: "#" });
  expect(fileKind("deploy/Dockerfile")).toEqual({ language: "txt", comment: "#" });
  expect(fileKind("a.b/settings.yml")).toEqual({ language: "yml", comment: "#" });
  expect(fileKind("src/app.ts")).toEqual({ language: "js", comment: "//" });
  expect(fileKind("db/schema.sql")).toEqual({ language: "sql", comment: "--" });
  expect(fileKind("README.md")).toEqual({ language: "md", comment: null });
  expect(fileKind("data.json")).toEqual({ language: "json", comment: null });
});

// The panel class run against fakes: a fake disk, a fake editor and a movable focused folder.
function panel() {
  const state = { cwd: "/a", disk: "old", release: null as null | (() => void) };
  const editors: any[] = [];
  const body = source.slice(source.indexOf("function location()")).replace("export default class Files extends View", "return class Files extends View");
  const names = ["View", "div", "svg", "v_flex", "h_flex", "Editor", "EditorState", "spaces", "panes", "focused", "exec", "readTextFile", "writeTextFile", "nextCommand", "watchFolder", "theme", "settings", "window"];
  const stub: Record<string, unknown> = {
    View: class {},
    EditorState: { new: ({ value }: { value: string }) => {
      const editor: any = { v: value, released: false, value: () => editor.v, set_value: (x: string) => { editor.v = x; }, on: (_n: string, f: any) => { editor.fire = () => f(null, cx); }, release: () => { editor.released = true; } };
      editors.push(editor);
      return editor;
    } },
    spaces: () => [{ active: true, id: state.cwd, folder: state.cwd }], panes: () => [], focused: () => null,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => state.disk,
    writeTextFile: async (_p: string, value: string) => { await new Promise<void>(r => { state.release = r; }); state.disk = value; },
    nextCommand: () => new Promise(() => {}), watchFolder: () => new Promise(() => {}),
    theme: () => ({}), settings: () => ({}), window: () => ({ platform: "linux" }),
  };
  const cx: any = { spawn: (f: any) => f(cx), notify() {}, timer: { every() {} } };
  const Files = new Function(...names, `${body}`)(...names.map(n => stub[n] ?? (() => ({}))));
  const files = new Files();
  files.init({}, cx);
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { files, cx, state, editors, flush };
}

test("Files keeps a save that finishes while another folder is shown", async () => {
  const { files, cx, state, editors, flush } = panel();
  await flush();
  files.show("f.txt", cx);
  await flush();
  editors[0].v = "new"; editors[0].fire();
  expect(files.dirty).toBe(true);
  files.save(cx);
  await flush();
  state.cwd = "/b"; files.refresh(cx);
  await flush();
  state.release!(); await flush();
  state.cwd = "/a"; files.refresh(cx);
  await flush();
  expect(files.dirty).toBe(false);
  expect(files.text).toBe("new");
  expect(files.saving).toBe(false);
});

test("Files reload applies the same text rules as opening a file", async () => {
  for (const [disk, message] of [["a\0b", "Binary file · no text preview"], [null, "This file is no longer available"]] as const) {
    const { files, cx, state, editors, flush } = panel();
    await flush();
    files.show("f.txt", cx);
    await flush();
    editors[0].v = "edited"; editors[0].fire();
    state.disk = disk as any;
    files.conflict = true; files.saveError = "The file changed outside Herdr";
    files.reload(cx);
    await flush();
    expect(files.code).toBe(null);
    expect(files.fileError).toBe(message);
    expect(files.conflict).toBe(false);
  }
  const { files, cx, state, editors, flush } = panel();
  await flush();
  files.show("f.txt", cx);
  await flush();
  state.disk = "x".repeat(400001);
  files.reload(cx);
  await flush();
  expect(files.editable).toBe(false);
  expect(editors.at(-1).v.endsWith("(file truncated)")).toBe(true);
});
