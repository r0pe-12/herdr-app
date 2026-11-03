# Files panel: editing and comment toggle — plan implementacije

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files panel mijenja i snima lokalne tekstualne fajlove, a editor
dobija `cmd-/` (`ctrl-/`) za zakomentarisanje i otkomentarisanje selektovanih
linija.

**Architecture:** Nova akcija `ToggleComment` u vendorovanom editoru
(`gpui-base`) radi nad svim selekcijama kao jedna undo transakcija, po uzoru
na `apply_indent`. Shell (`gpui-shell`) prosljeđuje novu JS opciju
`EditorState.new({ line_comment })`. `files` mod bira jezik i znak komentara
po imenu fajla, pravi editor za izmjene kad je fajl lokalan i snima preko
`writeTextFile` sa provjerom zastarjelog snapshota.

**Tech Stack:** Rust 1.95.0 (GPUI, vendor/gpui-kit), QuickJS mod (JavaScript),
Bun 1.4.4 testovi, Zig 0.16.0 (build ghostty-sys).

**Spec:** `docs/superpowers/specs/2026-11-03-files-edit-design.md`

## Global Constraints

- Commit poruke: lowercase conventional commit, jedna linija, **bez AI co-author linija** (AGENTS.md).
- Grana `feat/files-edit`. Nema push-a bez pitanja.
- Svaka `cargo` komanda ide sa `ZIG="$(brew --prefix zig@0.16)/bin/zig"` u okruženju.
- `vendor/gpui-kit` je poseban Cargo workspace: njegovi testovi se pokreću iz `vendor/gpui-kit`, ne iz root-a.
- Prečice: `cmd-/` na macOS-u i `ctrl-/` drugdje (kontekst editora `CONTEXT`). Snimanje: `cmd-s` (macOS) i `ctrl-s` (ostali) kroz `mod:files` → `files.save`.
- Fajl se može mijenjati samo ako je lokalan (`on == null`) i ima najviše `400000` znakova. Sve ostalo je readonly.
- Nikad ne pokretati golu `target/*/herdr-app` bez okruženja testa: `HERDR_APP_HOME=/var/tmp/herdr-files-test/home HC_SESSION=herdr-files-test XDG_STATE_HOME=/var/tmp/herdr-files-test/state HERDR_APP_NO_SOUND=1`. Ne dirati korisnikov pravi app ni core.
- Mod pravila: nema `setTimeout`, `cx` se ne čuva za kasnije, boje idu iz `theme()`.

## Review Focus

1. **`cmd-/` van editora** (terminal, lista fajlova, readonly fajl, fajl bez znaka komentara) mora i dalje otvoriti Help. Test `toggle_comment_falls_through_without_prefix_or_when_readonly` je u Task 1.
2. **Auto-reload dok je u toku čitanje:** ako korisnik počne da kuca dok `readTextFile` čeka, nova verzija sa diska ne smije pregaziti tekst. Pravilo (provjera `dirty` i identiteta editora poslije `await`) je u Task 4, Step 3.
3. **Greške pri snimanju koje nisu konflikt** (nema dozvole, preko 1 MiB): draft ostaje, poruka se vidi, nema dugmeta Reload. Ručna provjera sa `chmod 444` je u Task 5.
4. **CRLF fajlovi:** komentarisanje ne smije pokvariti `\r\n`, a linija sa samo `\r` je prazna. Test `toggle_comment_handles_crlf` je u Task 1.
5. **Dva brza snimanja zaredom:** očekivani snapshot se mijenja tek poslije uspješnog upisa, a drugo snimanje se ne pokreće dok prvo traje (`this.saving`). Pravilo je u Task 3, Step 5.

---

### Task 0: Okruženje za build

**Files:** nema izmjena u repou.

- [ ] **Step 1: Submodul i alati**

```bash
cd /Users/petar/work/personal/herdr-app
git submodule update --init --recursive
rustup toolchain install 1.95.0 --profile minimal
rustup override set 1.95.0
brew install zig@0.16 just bun
export ZIG="$(brew --prefix zig@0.16)/bin/zig"
"$ZIG" version   # 0.16.0
rustc --version  # rustc 1.95.0
bun --version    # 1.4.x
```

- [ ] **Step 2: Polazna tačka prolazi**

Run: `cargo test --locked --no-run`. Očekivano: build bez greške.
Run: `(cd vendor/gpui-kit && cargo test -p gpui-base --lib test_multi_cursor_indent)`. Očekivano: PASS.
Run: `bun test scripts/files.test.ts`. Očekivano: 3 pass.

Ako nešto ovdje pada prije naših izmjena, zaustaviti se i javiti.

---

### Task 1: `ToggleComment` u editoru (`gpui-base`)

**Files:**
- Create: `vendor/gpui-kit/crates/base/src/input/editor/comment.rs`
- Modify: `vendor/gpui-kit/crates/base/src/input/mod.rs` (oko 33. linije, pored `mod indent;`)
- Modify: `vendor/gpui-kit/crates/base/src/input/base/mode.rs` (`LayoutMode::CodeEditor` i `code_editor()`)
- Modify: `vendor/gpui-kit/crates/base/src/input/base/state.rs`: `actions!` (oko 74. linije), `KeyBinding`-i (oko 255–310. linije), `.on_action` registracija (oko 4644. linije), builderi u `impl InputBaseState<crate::input::EditorMode>` (oko 11188. linije), testovi u `mod tests` (pored `test_multi_cursor_indent_is_one_undo`, oko 10454. linije)

**Interfaces:**
- Produces:
  - `EditorState::line_comment(self, prefix: impl Into<SharedString>) -> Self`: builder. Prazan string znači bez komentara.
  - `EditorState::line_comment_prefix(&self) -> Option<SharedString>`
  - akcija `input::ToggleComment`
  - `InputBaseState::<M>::toggle_comment(&mut self, _: &ToggleComment, window: &mut Window, cx: &mut Context<Self>)` (`pub(super)`)

- [ ] **Step 1: Testovi koji padaju**

Helperi u `mod tests`:

```rust
fn env_editor(cx: &mut TestAppContext) -> InputView<EditorMode> {
    InputView::build_editor(cx, |state| state.line_comment("#"))
}

fn select(cx: &mut VisualTestContext, input: &Entity<EditorState>, text: &str, range: std::ops::Range<usize>) {
    cx.update(|window, cx| input.update(cx, |state, cx| {
        state.set_value(text, window, cx);
        state.set_selected_range(range, cx);
    }));
}

fn toggle(cx: &mut VisualTestContext, input: &Entity<EditorState>) {
    cx.update(|window, cx| input.update(cx, |state, cx| state.toggle_comment(&ToggleComment, window, cx)));
}

fn text(cx: &mut VisualTestContext, input: &Entity<EditorState>) -> String {
    input.read_with(cx, |state, _| state.text.to_string())
}
```

Testovi. Svaki pravi `env_editor` (osim gdje piše drugačije), radi `select` ili `setup_cursors`, zove `toggle` i provjerava:

| Test | Polazno | Selekcija | Poslije `toggle` |
|---|---|---|---|
| `toggle_comment_comments_selected_lines` | `"A=1\nB=2\nC=3"` | `0..7` | `"# A=1\n# B=2\nC=3"`, `selected_range() == 2..11` |
| `toggle_comment_uncomments_when_all_commented` | `"# A=1\n#B=2\nC=3"` | `0..10` | `"A=1\nB=2\nC=3"` |
| `toggle_comment_mixed_comments_without_doubling` | `"# A=1\nB=2"` | `0..9` | `"# A=1\n# B=2"`; drugi `toggle` (bez nove selekcije, ona je već `0..11`) daje `"A=1\nB=2"` |
| `toggle_comment_skips_blank_lines` | `"A=1\n\n  \nB=2"` | `0..11` | `"# A=1\n\n  \n# B=2"` |
| `toggle_comment_all_blank_is_noop` | `"\n\n"` | kursor `0..0` | tekst nepromijenjen, `undo_manager.undo_count() == 0` |
| `toggle_comment_selection_ending_at_column_zero_excludes_that_line` | `"A=1\nB=2\nC=3"` | `0..8` | `"# A=1\n# B=2\nC=3"` |
| `toggle_comment_inserts_at_minimum_indent` (helper sa `line_comment("//")`) | `"  a\n    b"` | `0..9` | `"  // a\n  //   b"`; drugi `toggle` (bez nove selekcije, ona je već `0..15`) vraća `"  a\n    b"` |
| `toggle_comment_multi_cursor_is_one_undo` | `setup_cursors("|A=1\nB=2\n|C=3")` | — | `assert_cursors("# |A=1\nB=2\n# |C=3")`, `undo_count() == 1`; poslije `undo(&Undo)`: `assert_cursors("|A=1\nB=2\n|C=3")` |
| `toggle_comment_handles_crlf` | `"A=1\r\n\r\nB=2\r\n"` | `0..12` | `"# A=1\r\n\r\n# B=2\r\n"`; drugi `toggle` (bez nove selekcije, ona je već `0..16`) vraća polazni tekst |

`toggle_comment_falls_through_without_prefix_or_when_readonly` ide kroz pravi
pritisak tastera, da dokaže da prečica ide dalje. Pravi svoj root view koji
renderuje `div().key_context("Root").on_action(|_: &Fallback, _, _| HIT.set(true)).child(editor)`,
uz test akciju `actions!(test_comment, [Fallback])` i `KeyBinding::new(key, Fallback, Some("Root"))`,
gdje je `key` `"cmd-/"` na macOS-u, a `"ctrl-/"` drugdje. Fokusira editor i zove
`cx.simulate_keystrokes(key)`. Provjere:
- (a) editor bez `line_comment` sa tekstom `"A=1"`: tekst ostaje `"A=1"`, `HIT == true`
- (b) editor sa `line_comment("#")` i `set_readonly(true, cx)`: tekst ostaje, `HIT == true`
- (c) editor sa `line_comment("#")`, izmjenljiv: tekst je `"# A=1"`, `HIT == false`

- [ ] **Step 2: Provjeriti da padaju**

Run: `cd vendor/gpui-kit && cargo test -p gpui-base --lib toggle_comment`
Očekivano: greška pri kompajliranju (`ToggleComment`, `line_comment`, `toggle_comment` ne postoje).

- [ ] **Step 3: Postavka `line_comment`**

- `mode.rs`: polje `line_comment: Option<SharedString>` u `LayoutMode::CodeEditor`, u `code_editor()` postavljeno na `None`. Dodati `pub(super) fn line_comment(&self) -> Option<SharedString>` (`None` van `CodeEditor`) i `pub(super) fn set_line_comment(&mut self, prefix: Option<SharedString>)`.
- `state.rs`, `impl InputBaseState<crate::input::EditorMode>`: builder `line_comment(prefix)` (prazan string → `None`) i getter `line_comment_prefix()`, sa doc komentarima u stilu `smart_indent`.

- [ ] **Step 4: Akcija, prečice i registracija**

- `ToggleComment` ide u `actions!(input, [...])`.
- Prečice, u stilu postojećih `#[cfg]` parova:
  - `#[cfg(target_os = "macos")] KeyBinding::new("cmd-/", ToggleComment, Some(CONTEXT))`
  - `#[cfg(not(target_os = "macos"))] KeyBinding::new("ctrl-/", ToggleComment, Some(CONTEXT))`
- U `render`, u bloku `.when(self.is_multi_line(), …)` unutar `.when(self.is_editable(), …)`, dodati `.on_action(window.listener_for(&entity, InputBaseState::toggle_comment))`.
- `mod.rs`: dodati `#[path = "editor/comment.rs"] mod comment;`.

- [ ] **Step 5: `editor/comment.rs`**

`impl<M: InputModeKind> InputBaseState<M> { pub(super) fn toggle_comment(...) }`.

Prvo provjera: ako `!self.is_editable() || !self.is_multi_line()` ili
`self.mode.line_comment()` nije `Some`, poziva se `cx.propagate()` i
izlazi. Ostatak:

```rust
// Redovi: sve što dodiruje bilo koja selekcija; nekolapsirana selekcija koja
// završava u koloni 0 ne uključuje taj posljednji red.
let mut rows = std::collections::BTreeSet::new();
for sel in self.selections.iter() {
    let start = self.text.offset_to_point(sel.start).row;
    let end_point = self.text.offset_to_point(sel.end);
    let end = if !sel.is_collapsed() && end_point.row > start && end_point.column == 0 { end_point.row - 1 } else { end_point.row };
    rows.extend(start..=end);
}
// Linija je prazna ako je slice_line(row) samo whitespace (uključujući '\r').
// Uvlaka = broj bajtova vodećih ' ' i '\t'.
// Zakomentarisana = poslije uvlake počinje sa prefix.
// Nijedna neprazna linija: return (pritisak potrošen, bez izmjene).
// Sve neprazne zakomentarisane: za svaku izmjena (pos..pos + prefix.len() + (1 ako slijedi ' ')) → "".
// Inače: min_indent = najmanja uvlaka nepraznih; svaka nezakomentarisana neprazna
//         dobija insert (line_start + min_indent .. isto) → format!("{prefix} ").
```

Izmjene su sortirane po početku i primjenjuju se kao u `apply_indent`:

```rust
let before: Vec<CursorSelection> = self.selections.iter().copied().collect();
self.undo_manager.begin_transaction();
self.replace_text_in_ranges(&edits, window, cx);
self.selections.replace_all(new_selections);
self.undo_manager.record_selections(before, self.selections.iter().copied().collect());
self.undo_manager.commit_transaction();
self.scroll_to(self.cursor(), None, cx);
cx.notify();
```

Mapiranje pozicije kroz izmjene (stari tekst → novi). Primjenjuje se na `start`
i `end` svake selekcije, uz `column_anchor = None`:

```rust
fn map_offset(edits: &[(Range<usize>, String)], offset: usize) -> usize {
    let mut delta: isize = 0;
    for (range, new) in edits {
        if range.is_empty() {
            if range.start <= offset { delta += new.len() as isize; }
        } else if range.end <= offset {
            delta -= (range.len() - new.len()) as isize;
        } else if range.start < offset {
            delta -= (offset - range.start) as isize; // unutar uklonjenog: na početak
        }
    }
    (offset as isize + delta) as usize
}
```

- [ ] **Step 6: Testovi prolaze**

Run: `cd vendor/gpui-kit && cargo test -p gpui-base --lib toggle_comment`. Očekivano: svih 10 PASS.
Run: `cd vendor/gpui-kit && cargo test -p gpui-base --lib indent`. Očekivano: PASS, bez regresija.

- [ ] **Step 7: Commit**

```bash
git add vendor/gpui-kit/crates/base/src/input
git commit -m "feat: toggle line comments in the code editor"
```

---

### Task 2: `line_comment` opcija u shellu (`gpui-shell`)

**Files:**
- Modify: `vendor/gpui-kit/crates/shell/src/entities.rs:176-202` (`EditorOptions` i `Default`), `:449-485` (`create_editor`)
- Modify: `vendor/gpui-kit/crates/shell/src/typings.rs:3151-3171` (`EditorState.new` opcije)
- Test: `vendor/gpui-kit/crates/shell/src/tests/render.rs` (pored `an_editor_holds_highlighted_code_beside_an_input`)

**Interfaces:**
- Consumes: `EditorState::line_comment(...)` i `line_comment_prefix()` iz Task 1.
- Produces: JS `EditorState.new({ ..., line_comment?: string })`.

- [ ] **Step 1: Test koji pada**

`an_editor_takes_a_line_comment_prefix`, istog oblika kao
`an_editor_holds_highlighted_code_beside_an_input`. Skripta u `init` radi
`this.code = EditorState.new({ language: "env", value: "A=1", line_comment: "#" })`,
a render vraća `div().child(Editor.new(this.code).h(120))`. Provjera:

```rust
let editor = runtime.entities().first_editor().expect("editor");
context.update(|_, cx| assert_eq!(editor.read(cx).line_comment_prefix().as_deref(), Some("#")));
```

- [ ] **Step 2: Provjeriti da pada**

Run: `cd vendor/gpui-kit && cargo test -p gpui-shell --lib an_editor_takes_a_line_comment_prefix`
Očekivano: FAIL sa `unknown field \`line_comment\``.

- [ ] **Step 3: Implementacija**

- `EditorOptions`: polje `pub line_comment: Option<String>` (u `Default`: `None`).
- `create_editor`: poslije `.soft_wrap(...)` primijeniti `state.line_comment(prefix)` kad postoji.
- `typings.rs`: dodati `/** Line comment prefix ("#", "//"): Cmd-/ (Ctrl-/) toggles it on the selected lines. HERDR. */ line_comment?: string;` u opcije `EditorState.new`.

- [ ] **Step 4: Prolazi**

Run: `cd vendor/gpui-kit && cargo test -p gpui-shell --lib editor`. Očekivano: PASS, uključujući postojeće editor testove.

- [ ] **Step 5: Commit**

```bash
git add vendor/gpui-kit/crates/shell/src
git commit -m "feat: let mods set the editor line comment prefix"
```

---

### Task 3: Files panel mijenja i snima fajlove

**Files:**
- Modify: `defaults/mods/files/main.js`
- Modify: `scripts/files.test.ts`
- Modify: `defaults/keys.macos.json`, `defaults/keys.json`
- Modify: `defaults/AGENTS.md` (pasus o Files panelu oko 178. linije i `EditorState` u sekciji `### UI` oko 892. linije)

**Interfaces:**
- Consumes: JS `EditorState.new({ line_comment })` (Task 2), `writeTextFile(path, text, expected)` i `nextCommand()` iz `herdr`.
- Produces:
  - top-level `fileKind(path: string): { language: string, comment: string | null }` u `main.js`, u bloku koji počinje komentarom `// File kinds:` i završava se prije `async function directory(`
  - polja instance `this.text` (posljednji učitan ili snimljen tekst), `this.dirty`, `this.editable`, `this.saving`, `this.saveError`, `this.conflict`
  - metode `save(cx)` i `reload(cx)`
  - mod komanda `files.save`

- [ ] **Step 1: Test koji pada (`scripts/files.test.ts`)**

```ts
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
```

- [ ] **Step 2: Provjeriti da pada**

Run: `bun test scripts/files.test.ts`. Očekivano: FAIL (blok `// File kinds:` ne postoji).

- [ ] **Step 3: `fileKind`**

Blok `// File kinds: syntax language and line comment prefix by name.` ide
odmah poslije `const key = …`. U njega se seli `LANG` i dodaje `COMMENT`
(ekstenzija/ime → prefiks), sa vrijednostima iz speca:

- `#`: env, sh, bash, zsh, fish, yaml, yml, toml, py, rb, pl, r, conf, cfg, ini, properties, i imena `Dockerfile`, `Makefile`, `.gitignore`, `.dockerignore`
- `//`: js, jsx, ts, tsx, mjs, cjs, mts, cts, jsonc, rs, go, c, h, cc, cpp, hpp, java, kt, swift, cs, php, scss, dart, zig
- `--`: sql, lua, hs

Pravila:
- `name` je posljednji segment putanje (`/` ili `\`).
- Env ime je `name === ".env"`, `name.startsWith(".env.")` ili `name.endsWith(".env")`. Tada je `language` `"env"`, a `comment` `"#"`.
- Inače je `ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt"`, `language = LANG[ext] ?? ext`, a `comment = COMMENT[name] ?? COMMENT[ext] ?? null`.

`show()` koristi `fileKind(path).language` umjesto dosadašnjeg računanja `ext`.

Run: `bun test scripts/files.test.ts`. Očekivano: 4 pass.

- [ ] **Step 4: Editor za izmjene u `show()`**

- `editable = !on && text.length <= 400000`.
- `EditorState.new({ ..., readonly: !editable, line_comment: editable ? kind.comment ?? undefined : undefined })`. `undefined` se izostavlja iz JSON-a.
- Postaviti `this.text = text`, `this.dirty = false`, `this.editable = editable` i obrisati `saveError` i `conflict`, i to **prije** `EditorState.new`.
- `this.code.on("change", (_e, cx) => { const d = this.code.value() !== this.text; if (d !== this.dirty) { this.dirty = d; cx.notify(); } })`.
- `show(null)` i promjena fajla vraćaju `dirty`, `saving`, `saveError` i `conflict` na početne vrijednosti.

- [ ] **Step 5: `save(cx)`, `reload(cx)`, komanda i header**

- `save(cx)`:
  - Izlazi ako nema `this.code`, `!this.editable`, `!this.dirty` ili `this.saving`.
  - Zapamti `code = this.code`, `file = this.file`, `value = code.value()` i `expected = this.text`, pa postavi `this.saving = true`.
  - U `cx.spawn` zove `await writeTextFile(`${this.root}/${file}`, value, expected)`.
  - Uspjeh, ako je `this.code === code`: `this.text = value`, `this.dirty = code.value() !== value`, brišu se `saveError` i `conflict`.
  - Greška: `this.saveError = e?.message ?? String(e)` i `this.conflict = /changed (outside Herdr|while saving)/.test(this.saveError)`.
  - `finally`: `this.saving = false; cx.notify()`.
- `reload(cx)`: ponovo čita fajl (`readTextFile`). Ako je `this.code` isti i tekst nije `null`, prvo `this.text = text`, pa `code.set_value(text)`, `dirty = false`, i brišu se greške.
- U `init`: `cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "save") this.save(cx); cx.notify(); } })`.
- Header, kad je `this.file` postavljen:
  - `●` (boja `t.blocked`) ispred imena kad je `dirty`
  - dugme `files-save` "Save" kad je `dirty && editable` (tekst "Saving…" dok je `saving`)
  - ispod headera traka `files-error` (`t.ansi1`, 12px) sa `saveError`, plus dugme `files-reload` "Reload" kad je `conflict`
  - dugmad u stilu `files-back` (`cursor_pointer`, `t.muted`, hover `t.hover`, `rounded(6)`, `px(8)`)
- `defaults/keys.macos.json`: sekcija `"mod:files": { "cmd-s": "files.save" }`. `defaults/keys.json`: `"mod:files": { "ctrl-s": "files.save" }`.

- [ ] **Step 6: Dokumentacija**

- `defaults/AGENTS.md`, pasus o Files panelu: on mijenja lokalne tekstualne fajlove do 400.000 znakova. `cmd-s` (`ctrl-s`, `files.save` u `mod:files`) snima i odbija upis preko fajla promijenjenog van Herdr-a (Reload). `cmd-/` (`ctrl-/`) zakomentariše ili otkomentariše selektovane linije. Fajlovi na drugim mašinama ostaju samo za čitanje.
- U `### UI`, uz `EditorState.new({...})`: dodati `line_comment` (npr. `"#"`), koji `cmd-/` (`ctrl-/`) uključuje i isključuje na selektovanim linijama.

- [ ] **Step 7: Provjera**

Run: `bun test scripts/files.test.ts`. Očekivano: 4 pass.
Run: `cargo build --locked`, pa `HERDR_APP_HOME=/var/tmp/herdr-files-test/home target/debug/herdr-app check defaults/mods/files`. Očekivano: exit 0.
Run: `cargo test --locked --bin herdr-app -- keys commands settings`. Očekivano: PASS (`keys` parsira nove sekcije, a vodič i dalje imenuje komande i ključeve).

- [ ] **Step 8: Commit**

```bash
git add defaults/mods/files/main.js scripts/files.test.ts defaults/keys.json defaults/keys.macos.json defaults/AGENTS.md
git commit -m "feat: edit and save local files in the files panel"
```

---

### Task 4: Zaštita nesnimljenih izmjena

**Files:**
- Modify: `defaults/mods/files/main.js` (`refresh`, `show`, header)

**Interfaces:**
- Consumes: `this.text`, `this.dirty`, `this.editable`, `save(cx)` iz Task 3.
- Produces: polje `this.leaving` (bool).

- [ ] **Step 1: ← sa nesnimljenim izmjenama**

- Klik na `files-back` kad je `dirty` postavlja `this.leaving = true` umjesto `show(null)`.
- Dok je `leaving`, header pokazuje "Unsaved changes" i tri dugmeta:
  - `files-leave-save`: `save`, pa kad uspije (bez `saveError`) `show(null)`
  - `files-leave-discard`: `show(null)`
  - `files-leave-cancel`: `leaving = false`
- `show()` uvijek vraća `leaving = false`.

- [ ] **Step 2: Promjena konteksta čuva nesnimljeni editor**

- Kad se u `refresh()` promijeni ključ i `this.dirty` je true, mapa `this.saved` za stari ključ dobija `{ folders, file, code: this.code, text: this.text, editable: this.editable }`. Prije `show(null)` treba postaviti `this.code = null`, da se editor ne oslobodi (`release`).
- Pri vraćanju na ključ, ako sačuvani unos ima `code`, polja se vraćaju direktno (`code`, `text`, `editable`, `dirty = true`, `file`) umjesto `show(saved.file, cx)`.
- Bez nesnimljenih izmjena ponašanje ostaje kao danas.

- [ ] **Step 3: Ponovno učitavanje fajla promijenjenog sa strane (dok nema nesnimljenih izmjena)**

Na kraju taska u `refresh()`, poslije `git status`:
- Ako `this.file && this.code && !this.dirty`, zapamtiti `code`, `file` i `context`, pa `await readTextFile(...)`.
- **Poslije `await`** ponovo provjeriti `this.current(context) && this.file === file && this.code === code && !this.dirty`.
- Tekst se preskače ako je `null`, ako sadrži `"\0"` ili ako je jednak `this.text`. Preskače se i kad je editor izmjenljiv, a novi tekst ima više od 400000 znakova.
- Inače: `this.text = text`, pa `code.set_value(...)` (readonly prikaz zadržava skraćivanje na 400000 + `"\n… (file truncated)"`).

- [ ] **Step 4: Provjera**

Run: `bun test scripts/files.test.ts`. Očekivano: 4 pass.
Run: `HERDR_APP_HOME=/var/tmp/herdr-files-test/home target/debug/herdr-app check defaults/mods/files`. Očekivano: exit 0.

- [ ] **Step 5: Commit**

```bash
git add defaults/mods/files/main.js
git commit -m "feat: keep unsaved files panel edits across navigation"
```

---

### Task 5: Puna provjera i ručni test

**Files:** nema novih izmjena (popravke idu u task koji je vlasnik koda).

- [ ] **Step 1: Svi automatski testovi**

Run: `just test` (Bun testovi i `cargo test --locked`). Očekivano: sve PASS.
Run: `(cd vendor/gpui-kit && cargo test -p gpui-base --lib toggle_comment && cargo test -p gpui-shell --lib editor)`. Očekivano: PASS.

- [ ] **Step 2: Izolovan app**

```bash
export HERDR_APP_HOME=/var/tmp/herdr-files-test/home HC_SESSION=herdr-files-test XDG_STATE_HOME=/var/tmp/herdr-files-test/state HERDR_APP_NO_SOUND=1
mkdir -p /var/tmp/herdr-files-test/proj && printf '# DB_HOST=prod.example.com\n# DB_NAME=prod\nDB_HOST=127.0.0.1\nDB_NAME=local\n' > /var/tmp/herdr-files-test/proj/.env
target/debug/herdr-app &   # pokrenuti u pozadini (run_in_background)
target/debug/herdr-app do space.new --folder /var/tmp/herdr-files-test/proj
target/debug/herdr-app do layout.select --stack panel-body --child files
target/debug/herdr-app do layout.show --id panel
target/debug/herdr-app status   # bez grešaka moda
```

Očekivano: `status` ne prijavljuje grešku za `files`. Snimak ekrana:
`target/debug/herdr-app shot /var/tmp/herdr-files-test/shot.png` pokazuje Files panel.

- [ ] **Step 3: Korisnik prolazi listu u tom prozoru**

1. Otvori `.env` i selektuj prve dvije linije, pa `cmd-/`: otkomentarisane su. Selektuj druge dvije, pa `cmd-/`: zakomentarisane su. Pojavljuje se `●`.
2. Selektuj sve četiri (miješano), pa `cmd-/`: sve su zakomentarisane, bez `# #`. `cmd-z` vraća stanje jednim korakom.
3. `cmd-s`: `●` nestaje, a `cat` u terminalu pokazuje novi sadržaj.
4. Izmijeni liniju bez snimanja, pa iz terminala `echo X=1 >> .env`, pa `cmd-s`: poruka o konfliktu i **Reload**. Reload učita verziju sa diska.
5. Bez nesnimljenih izmjena, `echo Y=2 >> .env` iz terminala: editor sam pokaže novu liniju (u roku od oko 10 s).
6. Izmijeni, pa ←: **Save / Discard / Cancel** rade.
7. `chmod 444 .env`, izmijeni, `cmd-s`: poruka o grešci bez Reload, a izmjena ostaje.
8. `cmd-/` u terminalu i na listi fajlova otvara Help. `cmd-shift-/` u editoru otvara Help.
9. `.env.local` dobija komentar `#`. `README.md` na `cmd-/` otvara Help.

- [ ] **Step 4: Gašenje testa**

```bash
target/debug/herdr-app do app.quit
hc server stop
rm -rf /var/tmp/herdr-files-test
```

(sa istim `HERDR_APP_HOME`/`HC_SESSION`/`XDG_STATE_HOME` iz Step 2)

---

### Task 6 (samo uz izričito odobrenje korisnika): Instalacija za svakodnevni rad

- [ ] **Step 1:** `just install`. Ovo zamjenjuje instalirani Herdr buildom iz forka, a build iz sourca se više ne ažurira sam.
- [ ] **Step 2:** U `~/.config/herdr-app/keys.json` dodati sekciju `"mod:files": { "cmd-s": "files.save" }`, bez diranja ostalih ključeva, pa provjeriti da `~/.config/herdr-app/keys.error` ne postoji.
