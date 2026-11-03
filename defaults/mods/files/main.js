// A lazy file browser for the focused pane's folder: bounded previews, and local text files can be edited and saved.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, nextCommand, watchFolder, theme, settings, window, home, shared, setShared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// File kinds: syntax language and line comment prefix by name.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const COMMENT = {};
for (const [prefix, names] of [
  ["#", "env sh bash zsh fish yaml yml toml py rb pl r conf cfg ini properties Dockerfile Makefile .gitignore .dockerignore"],
  ["//", "js jsx ts tsx mjs cjs mts cts jsonc rs go c h cc cpp hpp java kt swift cs php scss dart zig"],
  ["--", "sql lua hs"],
]) for (const name of names.split(" ")) COMMENT[name] = prefix;
function fileKind(path) {
  const name = path.split(/[\\/]/).pop();
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return { language: "env", comment: "#" };
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
  return { language: LANG[ext] ?? ext, comment: COMMENT[name] ?? COMMENT[ext] ?? null };
}
// Tree files are relative to the folder; a clicked link gives an absolute path on this machine.
const absolute = path => /^([\\/]|[A-Za-z]:[\\/])/.test(path);
// Where a file is, as the header shows it: below the folder, else from home.
function displayPath(file, root, home) {
  if (!absolute(file)) return file;
  if (root && file.startsWith(root + "/")) return file.slice(root.length + 1);
  if (home && file.startsWith(home + "/")) return "~/" + file.slice(home.length + 1);
  return file;
}
// Markdown opens rendered; its source is one toggle away.
const markdown = path => ["md", "markdown"].includes(fileKind(path).language);
// The file a markdown link names, in the form `file` has: on this machine an absolute
// path; below a remote folder a relative one (null past it). URLs and anchors are null.
function linkTarget(href, file, root, local) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  const path = href.split(/[?#]/)[0];
  if (!path || (!local && path.startsWith("/"))) return null;
  const base = local ? (absolute(file) ? file : `${root}/${file}`) : file;
  // Windows paths (drive letters, backslashes) aren't followed rather than mangled.
  if (/^[A-Za-z]:|\\/.test(base)) return null;
  const parts = path.startsWith("/") ? [] : base.split("/").slice(0, -1).filter(Boolean);
  for (const segment of path.split("/")) {
    let name = segment;
    try { name = decodeURIComponent(segment); } catch {}
    if (name === "" || name === ".") continue;
    if (name !== "..") parts.push(name);
    else if (parts.length) parts.pop();
    else if (!local) return null;
  }
  return local ? "/" + parts.join("/") : parts.join("/");
}
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map(); this.text = ""; this.dirty = false; this.editable = false; this.saving = false; this.saveError = null; this.conflict = false; this.leaving = false; this.pendingOpen = null; this.preview = false;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "save") this.save(cx); if (c === "preview") this.togglePreview(); cx.notify(); } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) {
        // Unsaved edits keep their editor with the folder; show(null) must not release it.
        const keep = this.dirty && this.code ? { code: this.code, text: this.text, editable: this.editable, saving: this.saving } : {};
        this.saved.set(this.context.key, { folders: this.folders, file: this.file, ...keep });
        if (keep.code) this.code = null;
      }
      // A link parked behind unsaved edits still opens here: the folder switch keeps those edits.
      const parked = this.pendingOpen, saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.code) {
        this.file = saved.file; this.code = saved.code; this.text = saved.text; this.editable = saved.editable; this.dirty = true; this.saving = Boolean(saved.saving);
        this.saved.set(next, { folders: saved.folders, file: saved.file });
      } else if (saved?.file && !parked) this.show(saved.file, cx);
      if (parked && this.dirty) { this.pendingOpen = parked; this.leaving = true; }
      else if (parked) this.show(parked, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        // A file changed on disk shows its new text, but never over unsaved edits (also checked after the read).
        if (this.file && this.code && !this.dirty) {
          const code = this.code, file = this.file, at = this.where(file);
          const text = await readTextFile(at.file, { on: at.on }).catch(() => null);
          if (this.current(context) && this.file === file && this.code === code && !this.dirty
            && text !== null && !text.includes("\0") && text !== this.text && !(this.editable && text.length > 400000)) {
            this.text = text;
            code.set_value(this.mdText = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text);
          }
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.text = ""; this.dirty = false; this.editable = false; this.saving = false; this.saveError = null; this.conflict = false; this.leaving = false; this.pendingOpen = null; this.preview = false;
    if (!path || !cx) return;
    const context = this.context, { file: full, on } = this.where(path);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), kind = fileKind(path), editable = !on && text.length <= 400000;
        this.text = text; this.dirty = false; this.editable = editable; this.saveError = null; this.conflict = false; this.preview = markdown(path);
        const code = this.code = EditorState.new({ language: kind.language, readonly: !editable,
          line_comment: editable ? kind.comment ?? undefined : undefined,
          value: this.mdText = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        code.on("change", (_e, cx) => {
          if (this.code !== code) return;
          const dirty = code.value() !== this.text;
          if (dirty !== this.dirty) { this.dirty = dirty; cx.notify(); }
        });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A tree file is in the shown folder, on its machine; an absolute path (a clicked link) is on this machine.
  where(path) {
    return absolute(path) ? { file: path, on: null } : { file: `${this.root}/${path}`, on: this.on };
  }

  // A clicked link asks through shared "files.open"; the copy that sees it first takes it.
  takeOpenRequest(cx) {
    const path = shared("files.open")?.path;
    if (!path) return;
    setShared("files.open", null);
    this.open(path, cx);
  }

  // Shows another file; unsaved edits ask first (the leave bar), then it opens.
  open(path, cx) {
    if (path === this.file) return;
    if (this.dirty) { this.pendingOpen = path; this.leaving = true; }
    else this.show(path, cx);
  }

  // Markdown: rendered or its source.
  togglePreview() {
    if (!this.code || !this.file || !markdown(this.file)) return;
    this.preview = !this.preview;
    // Rendered from a copy taken here (edits happen only in the source), not on every render.
    if (this.preview) this.mdText = this.code.value();
  }

  // A link in rendered markdown: a web or mail link goes to the system, a file opens here.
  followLink(href, cx) {
    if (/^(https?|mailto):/i.test(href)) {
      const platform = window()?.platform;
      exec(platform === "macos" ? "open" : platform === "windows" ? "explorer" : "xdg-open", [href]).catch(() => {});
      return;
    }
    const here = this.file && this.where(this.file);
    const target = here && linkTarget(href, this.file, this.root, !here.on);
    // A link to this same file (its top, a section) stays here.
    if (target && target !== this.file && target !== here.file) this.open(target, cx);
  }

  // Leaves the unsaved file for the one a link asked for, or for the list.
  leave(cx) {
    const next = this.pendingOpen;
    this.show(next ?? null, next ? cx : undefined);
  }

  // Writes only over the text last loaded or saved; `after` runs when that succeeded and nothing newer was typed.
  save(cx, after) {
    if (!this.code || !this.editable || !this.dirty || this.saving) return;
    const code = this.code, file = this.file, value = code.value(), expected = this.text, target = this.where(file).file;
    this.saving = true; this.saveError = null; this.conflict = false;
    cx.spawn(async cx => {
      try {
        await writeTextFile(target, value, expected);
        // Another folder is shown: its kept entry takes the saved text, and the editor is dropped when clean.
        const kept = this.code === code ? null : [...this.saved.values()].find(s => s.code === code);
        if (kept) {
          kept.text = value; kept.saving = false;
          if (code.value() === value) { code.release(); delete kept.code; }
        } else if (this.code === code) {
          this.text = value; this.dirty = code.value() !== value; this.saveError = null; this.conflict = false;
          if (!this.dirty) after?.(cx);
        }
      } catch (e) {
        if (this.code === code) {
          this.saveError = e?.message ?? String(e);
          this.conflict = /changed (outside Herdr|while saving)/.test(this.saveError);
        }
      } finally {
        if (this.code === code) this.saving = false;
        else for (const kept of this.saved.values()) if (kept.code === code) kept.saving = false;
        cx.notify();
      }
    });
  }

  // Replaces the editor's text with the file on disk, dropping unsaved edits.
  reload(cx) {
    const code = this.code, file = this.file, context = this.context, at = file && this.where(file);
    if (!code || !file) return;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(at.file, { on: at.on });
        if (this.code === code && this.current(context) && (text === null || text.includes("\0") || text.length > 400000)) this.show(file, cx);
        else if (this.code === code && this.current(context)) {
          this.text = text; code.set_value(this.mdText = text); this.dirty = false; this.saveError = null; this.conflict = false;
        }
      } catch (e) { if (this.code === code) this.saveError = e?.message ?? String(e); }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    this.takeOpenRequest(cx);
    const t = theme();
    const button = (id, label, run) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => { run(cx); cx.notify(); }).child(label);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { if (this.dirty) { this.leaving = true; this.pendingOpen = null; } else this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.file) && this.dirty, el => el.child(div().flex_none().text_color(t.blocked).child("●")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ? displayPath(this.file, this.root, home()) : this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file) && this.dirty && this.editable, el => el.child(button("files-save", this.saving ? "Saving…" : "Save", cx => this.save(cx))))
        .when(Boolean(this.file && this.code) && markdown(this.file), el => el.child(button("files-mode", this.preview ? "Edit" : "Preview", () => this.togglePreview()))))
      .when(Boolean(this.file) && this.leaving, el => el.child(h_flex().flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child("Unsaved changes"))
        .child(button("files-leave-save", "Save", cx => this.save(cx, cx => this.leave(cx))))
        .child(button("files-leave-discard", "Discard", cx => this.leave(cx)))
        .child(button("files-leave-cancel", "Cancel", () => { this.leaving = false; this.pendingOpen = null; }))))
      .when(Boolean(this.file) && Boolean(this.saveError), el => el.child(h_flex().flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().id("files-error").flex_1().min_w(0).text_size(12).text_color(t.ansi1).child(this.saveError))
        .when(this.conflict, el => el.child(button("files-reload", "Reload", cx => this.reload(cx))))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(!this.code ? div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")
        : this.preview ? div().id("files-md-frame").flex_1().min_h(0).px(16).py(12).child(TextView.markdown("files-md", this.mdText ?? "").selectable(true).scrollable(true).size_full()
          .on_link_click((url, cx) => { this.followLink(url, cx); cx.notify(); }))
        : Editor.new(this.code).flex_1().min_h(0)));
  }
}
