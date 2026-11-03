# Files panel: editing local files and toggling comments

Datum: 2026-11-03 · Grana: `feat/files-edit` · Fork: `r0pe-12/herdr-app`

## Cilj

Files panel danas samo prikazuje fajl. Treba da može i da ga mijenja i snimi,
prvenstveno `.env` fajlove u kojima se prebacuju baze. U editoru treba prečica
za brzo zakomentarisanje i otkomentarisanje selektovanih linija.

Uspjeh izgleda ovako: otvoriš lokalni `.env` u Files panelu, selektuješ blok
`DB_*` linija, pritisneš `cmd-/` i blok je zakomentarisan. Ponovo `cmd-/` i
otkomentarisan je. `cmd-s` snima fajl, i to nikad preko izmjene koju je neko
drugi u međuvremenu napravio na disku.

## Dogovorene odluke

- Samo lokalni fajlovi. Fajlovi na SSH mašinama ostaju samo za čitanje.
- Komentarisanje radi kao u VS Code-u: ako su sve linije zakomentarisane,
  skida komentar, a inače komentariše sve. Već zakomentarisane linije se pri
  komentarisanju **ne komentarišu duplo** (nema `# # `), kao na pregledu koji je
  odabran.
- `cmd-/` (Linux i Windows: `ctrl-/`) komentariše samo dok je fokus u editoru
  koji to može. Svuda drugo i dalje otvara Help. `cmd-shift-/` uvijek otvara Help.
- Rade se izmjene editora u forku (`vendor/gpui-kit`), a ne samo mod, jer JS
  strana editora ne vidi selekciju.

## 1. Editor: akcija `ToggleComment` (`vendor/gpui-kit/crates/base`)

**Gdje:** nova datoteka `src/input/editor/comment.rs`, po uzoru na
`apply_indent` u `editor/indent.rs`. Akcija `ToggleComment` ide u
`actions!(input, …)` u `base/state.rs`, uz prečice u istom kontekstu kao ostale
editorove (`CONTEXT`): `cmd-/` na macOS-u i `ctrl-/` drugdje.

**Nova postavka:** `line_comment: Option<SharedString>` na stanju editora, uz
builder `.line_comment(...)`.

**Ponašanje:**

1. Ako editor nije izmjenljiv (readonly), nije višelinijski ili nema
   `line_comment` (ili je prazan), poziva se `cx.propagate()`. Tada pritisak ide
   dalje, pa `cmd-/` otvara Help.
2. Linije koje se obrađuju su sve koje dodiruje bilo koja selekcija ili kursor.
   Izuzetak: kad nekolapsirana selekcija završava u koloni 0 sljedeće linije,
   ta posljednja linija se ne računa.
3. Prazne linije, tj. one sa samo whitespace-om (uključujući `\r`), se
   preskaču. Ako su sve linije prazne, ne radi se ništa, ali se pritisak
   troši (Help se ne otvara).
4. Linija je zakomentarisana ako, poslije vodećeg whitespace-a, počinje sa
   `line_comment`.
5. Ako su sve neprazne linije zakomentarisane, uklanja se `line_comment` i
   jedan razmak iza njega, ako postoji.
6. Inače se `line_comment + " "` ubacuje u svaku nezakomentarisanu nepraznu
   liniju, na najmanju vodeću uvlaku među obrađenim nepraznim linijama, pa
   poravnati blokovi ostaju poravnati. Već zakomentarisane linije se ne diraju.
7. Sve izmjene idu kao jedna undo transakcija
   (`undo_manager.begin_transaction` / `record_selections` /
   `commit_transaction`). Selekcije se preračunavaju kroz izmjene, kao kod
   indent-a, i ostaju na istim linijama.

**Shell (`vendor/gpui-kit/crates/shell`):**

- `entities.rs`: `EditorOptions` dobija `line_comment: Option<String>`.
  Struct ima `deny_unknown_fields`, pa je ovo obavezno. `create_editor` je
  prosljeđuje builderu.
- `typings.rs`: `EditorState.new({ line_comment?: string })`, sa kratkim
  opisom.

## 2. Files panel (`defaults/mods/files/main.js`)

**Kad se fajl može mijenjati:** kad je lokalan (`on` je null), tekstualan i
nije skraćen za prikaz (do 400.000 znakova). Inače ostaje samo za čitanje, kao
danas, uključujući binarne fajlove i fajlove koji se ne mogu pročitati.

**Jezik i znak komentara po imenu fajla:**

- `.env`, `.env.*` i `*.env` dobijaju jezik `env`. Do sada je `.env.local`
  dobijao "jezik" `local`.
- `#`: env, sh, bash, zsh, fish, yaml, yml, toml, py, rb, pl, r, conf, cfg,
  ini, properties, `Dockerfile`, `Makefile`, `.gitignore`, `.dockerignore`.
- `//`: js, jsx, ts, tsx, mjs, cjs, mts, cts, jsonc, rs, go, c, h, cc, cpp,
  hpp, java, kt, swift, cs, php, scss, dart, zig.
- `--`: sql, lua, hs.
- Za ostale nema znaka komentara, pa `cmd-/` otvara Help.

**Stanje:** pamti se tekst koji je posljednji učitan ili snimljen. Fajl ima
nesnimljene izmjene kad se `value()` razlikuje od tog teksta. Računa se na
`on("change")`, a ponovno crtanje se radi samo kad se to stanje promijeni.

**Header:**

- Kad ima nesnimljenih izmjena: `●` ispred imena fajla i dugme **Save**.
- Kad snimanje ne uspije: crvena linija sa porukom i, ako se fajl promijenio
  na disku, dugme **Reload** (učita verziju sa diska i odbaci tvoje izmjene).
  Ostale greške (preko 1 MiB, nema dozvole) se prikazuju kako stignu.
- Strelica ← sa nesnimljenim izmjenama ne vraća odmah na listu. Header nudi
  **Save / Discard / Cancel**.

**Snimanje:** `writeTextFile(root/path, value, zapamćeni tekst)`. Na uspjeh,
zapamćeni tekst postaje snimljena vrijednost i `●` nestaje.

**Prečica za snimanje:** u `init` se pokreće petlja `nextCommand()`. Komanda
`save` snima ako ova kopija moda ima otvoren fajl sa nesnimljenim izmjenama.

**Promjena fajla sa strane:** kad se panel osvježi (watch foldera ili tajmer
od 10 s) dok je fajl otvoren bez nesnimljenih izmjena, fajl se ponovo pročita.
Ako se razlikuje, novi tekst ide u editor i on postaje zapamćeni tekst. Fajl
sa nesnimljenim izmjenama se nikad ne mijenja sam od sebe; konflikt se
otkriva pri snimanju.

**Promjena foldera:** kad se kontekst promijeni (fokus na pane u drugom
folderu), otvoreni fajl sa nesnimljenim izmjenama se ne gasi. Njegov editor i
zapamćeni tekst se čuvaju uz taj kontekst i vraćaju se kad se kontekst vrati.
Bez nesnimljenih izmjena sve ostaje kao danas: fajl se pri povratku ponovo
čita.

## 3. Prečice i dokumentacija

- `defaults/keys.macos.json`: `"mod:files": { "cmd-s": "files.save" }`.
- `defaults/keys.json`: `"mod:files": { "ctrl-s": "files.save" }`.
- Postojeći `~/.config/herdr-app/keys.json` se ne ažurira sam. Uz dozvolu
  korisnika dodaje mu se ista `mod:files` sekcija.
- `defaults/AGENTS.md`: opis Files panela (mijenja lokalne fajlove, `cmd-s` /
  `ctrl-s`, `cmd-/` / `ctrl-/`) i opcija `line_comment` u opisu `EditorState`.

## 4. Testiranje

- **Rust testovi editora**, u postojećem stilu testova u `base`:
  - komentarisanje i otkomentarisanje
  - miješane linije (komentariše sve, bez dupliranja)
  - preskakanje praznih linija
  - selekcija koja završava u koloni 0
  - uvlaka (najmanja kolona)
  - više kursora
  - jedan undo korak, uz vraćanje selekcija
  - readonly i bez `line_comment`: propagira
  - CRLF linije
- **Shell test:** `EditorState.new` prihvata `line_comment`.
- **Automatske provjere:** `cargo test` za cijeli workspace, jer `cargo test`
  provjerava i da `defaults/AGENTS.md` pominje komande i settings ključeve.
  Mod se provjerava sa `herdr-app check`.
- **Ručni test na Macu**, sa privremenim `HERDR_APP_HOME` i izolovanom core
  sesijom (nikad pravi app). Provjerava se:
  - `.env` i `.env.local`: `cmd-/` na bloku, na miješanom bloku i undo
  - `cmd-s`
  - izmjena fajla sa strane (bez i sa nesnimljenim izmjenama)
  - ← sa nesnimljenim izmjenama
  - `cmd-/` van editora otvara Help

## Van opsega

Snimanje preko SSH, pravljenje, preimenovanje i brisanje fajlova, dugme
**Overwrite**, blok komentari (`/* */`), duplo komentarisanje i promjena
prečice preko `keys.json` (`cmd-/` je u kodu editora).
