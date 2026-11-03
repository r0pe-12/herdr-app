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
const displayPath = new Function(`${kindsSource}; return displayPath;`)();
const linkTarget = new Function(`${kindsSource}; return linkTarget;`)();

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

test("Files shows a path below the folder, else from home", () => {
  expect(displayPath("src/a.ts", "/p", "/Users/me")).toBe("src/a.ts");
  expect(displayPath("/p/src/a.ts", "/p", "/Users/me")).toBe("src/a.ts");
  expect(displayPath("/Users/me/.config/x/.env", "/p", "/Users/me")).toBe("~/.config/x/.env");
  expect(displayPath("/etc/hosts", "/p", "/Users/me")).toBe("/etc/hosts");
});

test("Files follows markdown links to files, here or below the remote folder", () => {
  expect(linkTarget("docs/mods.md", "README.md", "/p", true)).toBe("/p/docs/mods.md");
  expect(linkTarget("../defaults/AGENTS.md#keys-keysjson", "docs/mods.md", "/p", true)).toBe("/p/defaults/AGENTS.md");
  expect(linkTarget("./a%20b.md", "/Users/me/x/n.md", "/p", true)).toBe("/Users/me/x/a b.md");
  expect(linkTarget("/etc/hosts", "README.md", "/p", true)).toBe("/etc/hosts");
  expect(linkTarget("../../../up.md", "docs/mods.md", "/p", true)).toBe("/up.md");
  expect(linkTarget("docs/mods.md?plain=1", "README.md", "/p", false)).toBe("docs/mods.md");
  expect(linkTarget("../x.md", "README.md", "/p", false)).toBe(null);
  expect(linkTarget("/etc/hosts", "README.md", "/p", false)).toBe(null);
  expect(linkTarget("https://herdr.dev", "README.md", "/p", true)).toBe(null);
  expect(linkTarget("mailto:a@b.c", "README.md", "/p", true)).toBe(null);
  expect(linkTarget("#install", "README.md", "/p", true)).toBe(null);
  expect(linkTarget("b.md", "C:\\Users\\x\\a.md", "C:\\Users\\x", true)).toBe(null);
});

// The panel class run against fakes: a fake disk, a fake editor and a movable focused folder.
function panel() {
  const state = { cwd: "/a", machine: null as null | string, disk: "old", release: null as null | (() => void),
    reads: [] as [string, string | null][], writes: [] as string[], shared: {} as Record<string, unknown>, execs: [] as [string, string[]][] };
  const editors: any[] = [];
  const body = source.slice(source.indexOf("function location()")).replace("export default class Files extends View", "return class Files extends View");
  const names = ["View", "div", "svg", "v_flex", "h_flex", "Editor", "EditorState", "TextView", "spaces", "panes", "focused", "exec", "readTextFile", "writeTextFile", "nextCommand", "watchFolder", "theme", "settings", "window", "home", "shared", "setShared"];
  const stub: Record<string, unknown> = {
    View: class {},
    EditorState: { new: ({ value }: { value: string }) => {
      const editor: any = { v: value, released: false, value: () => editor.v, set_value: (x: string) => { editor.v = x; }, on: (_n: string, f: any) => { editor.fire = () => f(null, cx); }, release: () => { editor.released = true; } };
      editors.push(editor);
      return editor;
    } },
    spaces: () => [{ active: true, id: state.cwd, folder: state.cwd, machine: state.machine }], panes: () => [], focused: () => null,
    exec: async (c: string, a: string[]) => { state.execs.push([c, a]); return { code: 0, stdout: "", stderr: "" }; },
    readTextFile: async (p: string, o?: { on?: string | null }) => { state.reads.push([p, o?.on ?? null]); return state.disk; },
    writeTextFile: async (p: string, value: string) => { state.writes.push(p); await new Promise<void>(r => { state.release = r; }); state.disk = value; },
    home: () => "/Users/me", shared: (k: string) => state.shared[k], setShared: (k: string, v: unknown) => { state.shared[k] = v; },
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

test("Files opens a clicked file on this machine and keeps unsaved edits first", async () => {
  const { files, cx, state, editors, flush } = panel();
  state.machine = "vps"; files.refresh(cx);
  await flush();
  state.shared["files.open"] = { path: "/Users/me/notes/.env" };
  files.takeOpenRequest(cx);
  await flush();
  expect(state.shared["files.open"]).toBe(null);
  expect(files.file).toBe("/Users/me/notes/.env");
  expect(state.reads.at(-1)).toEqual(["/Users/me/notes/.env", null]);
  expect(files.editable).toBe(true);
  editors.at(-1).v = "edited"; editors.at(-1).fire();
  state.shared["files.open"] = { path: "/Users/me/other.txt" };
  files.takeOpenRequest(cx);
  await flush();
  expect(files.file).toBe("/Users/me/notes/.env");
  expect(files.leaving).toBe(true);
  files.leave(cx);
  await flush();
  expect(files.file).toBe("/Users/me/other.txt");
  expect(files.leaving).toBe(false);
  editors.at(-1).v = "saved"; editors.at(-1).fire();
  files.save(cx);
  await flush();
  expect(state.writes.at(-1)).toBe("/Users/me/other.txt");
  state.release!(); await flush();
  expect(files.dirty).toBe(false);
});

test("Files still opens a parked link when the click also moves to another folder", async () => {
  const { files, cx, state, editors, flush } = panel();
  await flush();
  files.show("f.txt", cx);
  await flush();
  editors.at(-1).v = "edited"; editors.at(-1).fire();
  state.shared["files.open"] = { path: "/Users/me/notes/.env" };
  files.takeOpenRequest(cx);
  expect(files.leaving).toBe(true);
  state.cwd = "/b"; files.refresh(cx);
  await flush();
  expect(files.file).toBe("/Users/me/notes/.env");
  state.cwd = "/a"; files.refresh(cx);
  await flush();
  expect(files.file).toBe("f.txt");
  expect(files.dirty).toBe(true);
});

test("Files shows markdown rendered, switches to its source and back, and follows its links", async () => {
  const { files, cx, state, editors, flush } = panel();
  await flush();
  state.disk = "# Title\n[docs](docs/mods.md)";
  files.show("README.md", cx);
  await flush();
  expect(files.preview).toBe(true);
  files.togglePreview();
  expect(files.preview).toBe(false);
  editors.at(-1).v = "# Changed"; editors.at(-1).fire();
  files.togglePreview();
  expect(files.preview).toBe(true);
  expect(files.mdText).toBe("# Changed");
  files.followLink("./README.md#top", cx);
  expect(files.leaving).toBe(false);
  expect(files.code).toBe(editors.at(-1));
  files.followLink("https://herdr.dev", cx);
  expect(state.execs.at(-1)).toEqual(["xdg-open", ["https://herdr.dev"]]);
  files.followLink("#install", cx);
  expect(files.file).toBe("README.md");
  files.followLink("docs/mods.md", cx);
  expect(files.leaving).toBe(true);
  expect(files.pendingOpen).toBe("/a/docs/mods.md");
  files.leave(cx);
  await flush();
  expect(files.file).toBe("/a/docs/mods.md");
  expect(files.preview).toBe(true);
  state.disk = "plain";
  files.show("notes.txt", cx);
  await flush();
  expect(files.preview).toBe(false);
  files.togglePreview();
  expect(files.preview).toBe(false);
});
