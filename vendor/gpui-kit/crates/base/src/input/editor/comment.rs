//! Toggling line comments on the selected lines.

use crate::input::{
    InputBaseState, InputModeKind, RopeExt, ToggleComment, cursor::CursorSelection,
};
use gpui::{Context, Window};
use std::collections::BTreeSet;
use std::ops::Range;

/// One line a toggle looks at.
struct CommentLine {
    /// Byte offset of the line start.
    start: usize,
    /// Bytes of leading spaces and tabs.
    indent: usize,
    /// Whether the text after the indent starts with the comment prefix.
    commented: bool,
    /// Bytes to remove to uncomment: the prefix and one space after it.
    uncomment_len: usize,
}

/// Where `offset` lands once `edits` (sorted, disjoint, in old-text offsets)
/// are applied. An offset inside removed text moves to where that text began.
fn map_offset(edits: &[(Range<usize>, String)], offset: usize) -> usize {
    let mut delta: isize = 0;
    for (range, new) in edits {
        if range.is_empty() {
            if range.start <= offset {
                delta += new.len() as isize;
            }
        } else if range.end <= offset {
            delta -= (range.len() - new.len()) as isize;
        } else if range.start < offset {
            delta -= (offset - range.start) as isize;
        }
    }
    (offset as isize + delta) as usize
}

impl<M: InputModeKind> InputBaseState<M> {
    /// Comment or uncomment every line the selections touch, as one undo step.
    ///
    /// If every non-blank line is already commented the comments are removed;
    /// otherwise the lines that lack one get a comment at the smallest indent,
    /// and lines that already have one are left alone. Without a prefix, or
    /// while read-only, the key press goes on to the host.
    pub(super) fn toggle_comment(
        &mut self,
        _: &ToggleComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(prefix) = self.mode.line_comment() else {
            cx.propagate();
            return;
        };
        if !self.is_editable() || !self.is_multi_line() {
            cx.propagate();
            return;
        }

        // Every row a selection touches. A selection that ends in column 0 of a
        // later row leaves that row out: nothing on it is selected.
        let mut rows = BTreeSet::new();
        for sel in self.selections.iter() {
            let start = self.text.offset_to_point(sel.start).row;
            let end_point = self.text.offset_to_point(sel.end);
            let end = if !sel.is_collapsed() && end_point.row > start && end_point.column == 0 {
                end_point.row - 1
            } else {
                end_point.row
            };
            rows.extend(start..=end);
        }

        // Blank lines (whitespace only, `\r` included) are skipped.
        let prefix = prefix.as_ref();
        let lines: Vec<CommentLine> = rows
            .into_iter()
            .filter_map(|row| {
                let text = self.text.slice_line(row).to_string();
                if text.trim().is_empty() {
                    return None;
                }
                let indent = text
                    .bytes()
                    .take_while(|byte| matches!(byte, b' ' | b'\t'))
                    .count();
                let rest = &text[indent..];
                let after_prefix = rest.strip_prefix(prefix);
                let commented = after_prefix.is_some();
                let uncomment_len = prefix.len()
                    + usize::from(after_prefix.is_some_and(|after| after.starts_with(' ')));
                Some(CommentLine {
                    start: self.text.line_start_offset(row),
                    indent,
                    commented,
                    uncomment_len,
                })
            })
            .collect();
        if lines.is_empty() {
            return;
        }

        let edits: Vec<(Range<usize>, String)> = if lines.iter().all(|line| line.commented) {
            lines
                .iter()
                .map(|line| {
                    let at = line.start + line.indent;
                    (at..at + line.uncomment_len, String::new())
                })
                .collect()
        } else {
            let min_indent = lines.iter().map(|line| line.indent).min().unwrap_or(0);
            lines
                .iter()
                .filter(|line| !line.commented)
                .map(|line| {
                    let at = line.start + min_indent;
                    (at..at, format!("{prefix} "))
                })
                .collect()
        };

        let before: Vec<CursorSelection> = self.selections.iter().copied().collect();
        let new_selections: Vec<CursorSelection> = self
            .selections
            .iter()
            .map(|sel| {
                let mut selection = *sel;
                selection.start = map_offset(&edits, sel.start);
                selection.end = map_offset(&edits, sel.end);
                selection.column_anchor = None;
                selection
            })
            .collect();

        self.undo_manager.begin_transaction();
        self.replace_text_in_ranges(&edits, window, cx);
        self.selections.replace_all(new_selections);
        let after: Vec<CursorSelection> = self.selections.iter().copied().collect();
        self.undo_manager.record_selections(before, after);
        self.undo_manager.commit_transaction();

        self.scroll_to(self.cursor(), None, cx);
        cx.notify();
    }
}
