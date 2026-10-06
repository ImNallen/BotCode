//! Replay history for a terminal session, ported from T3 Code's terminal manager.
use std::collections::VecDeque;

pub const MAX_LINES: usize = 5_000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;

struct Chunk {
    text: String,
    newlines: usize,
}

/// The tail of a terminal's output, capped by lines and bytes and trimmed from the front.
/// The unterminated last line counts as a line.
pub struct History {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    newlines: usize,
    max_lines: usize,
    max_bytes: usize,
}
impl Default for History {
    fn default() -> Self {
        Self::new(MAX_LINES, MAX_BYTES)
    }
}
impl History {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        assert!(max_lines > 0 && max_bytes > 0);
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            newlines: 0,
            max_lines,
            max_bytes,
        }
    }
    pub fn append(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let newlines = text.matches('\n').count();
        match self.chunks.back_mut() {
            Some(last) if last.text.len() + text.len() <= CHUNK_BYTES => {
                last.text.push_str(text);
                last.newlines += newlines;
            }
            _ => self.chunks.push_back(Chunk {
                text: text.to_owned(),
                newlines,
            }),
        }
        self.bytes += text.len();
        self.newlines += newlines;
        self.trim();
    }
    pub fn value(&self) -> String {
        let mut value = String::with_capacity(self.bytes);
        for chunk in &self.chunks {
            value.push_str(&chunk.text);
        }
        value
    }
    fn trim(&mut self) {
        let terminated = self
            .chunks
            .back()
            .is_some_and(|chunk| chunk.text.ends_with('\n'));
        let mut excess_lines =
            (self.newlines + usize::from(!terminated)).saturating_sub(self.max_lines);
        while excess_lines > 0 {
            let front = self.chunks.front().expect("excess lines imply a chunk");
            if front.newlines < excess_lines {
                excess_lines -= front.newlines;
                self.pop_front();
                continue;
            }
            let cut = front
                .text
                .match_indices('\n')
                .nth(excess_lines - 1)
                .map(|(at, _)| at + 1)
                .expect("the chunk holds enough newlines");
            self.drop_front(cut);
            excess_lines = 0;
        }
        while self.bytes > self.max_bytes {
            let excess = self.bytes - self.max_bytes;
            let front = self.chunks.front().expect("excess bytes imply a chunk");
            if front.text.len() <= excess {
                self.pop_front();
                continue;
            }
            let mut cut = excess;
            while !front.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.drop_front(cut);
        }
    }
    fn pop_front(&mut self) {
        let chunk = self.chunks.pop_front().expect("a chunk to pop");
        self.bytes -= chunk.text.len();
        self.newlines -= chunk.newlines;
    }
    fn drop_front(&mut self, cut: usize) {
        let front = self.chunks.front_mut().expect("a chunk to cut");
        if cut == front.text.len() {
            self.pop_front();
            return;
        }
        let newlines = front.text[..cut].matches('\n').count();
        front.text.drain(..cut);
        front.newlines -= newlines;
        self.bytes -= cut;
        self.newlines -= newlines;
    }
}

/// Decodes PTY bytes, carrying an incomplete trailing UTF-8 sequence in `carry` to the next read.
pub fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let complete = carry.len() - incomplete_tail(carry);
    let text = String::from_utf8_lossy(&carry[..complete]).into_owned();
    carry.drain(..complete);
    text
}
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needed = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

/// Strips terminal query and reply traffic from output before it enters history, so a replayed
/// snapshot cannot make the terminal answer again. Returns the visible text and the incomplete
/// control sequence to prepend to the next chunk.
pub fn sanitize(pending: &str, data: &str) -> (String, String) {
    let input: Vec<char> = pending.chars().chain(data.chars()).collect();
    let text = |from: usize, to: usize| input[from..to].iter().collect::<String>();
    let mut visible = String::new();
    let mut index = 0;
    while index < input.len() {
        let c = input[index];
        let csi_start = match c {
            '\u{1b}' if input.get(index + 1) == Some(&'[') => Some(index + 2),
            '\u{9b}' => Some(index + 1),
            _ => None,
        };
        if let Some(start) = csi_start {
            let Some(end) = (start..input.len()).find(|&i| is_csi_final(input[i])) else {
                return (visible, text(index, input.len()));
            };
            if !strip_csi(&text(start, end), input[end]) {
                visible.push_str(&text(index, end + 1));
            }
            index = end + 1;
            continue;
        }
        let string_start = match (c, input.get(index + 1)) {
            ('\u{1b}', Some(&kind @ (']' | 'P' | '^' | '_'))) => Some((kind, index + 2)),
            ('\u{9d}', _) => Some((']', index + 1)),
            ('\u{90}', _) => Some(('P', index + 1)),
            ('\u{9e}' | '\u{9f}', _) => Some(('^', index + 1)),
            _ => None,
        };
        if let Some((kind, start)) = string_start {
            let Some(end) = string_terminator(&input, start) else {
                return (visible, text(index, input.len()));
            };
            let body = text(start, end);
            let content = strip_string_terminator(&body);
            let strip = match kind {
                ']' => strip_osc(content),
                'P' => strip_dcs(content),
                _ => false,
            };
            if !strip {
                visible.push_str(&text(index, end));
            }
            index = end;
            continue;
        }
        if c == '\u{1b}' {
            if index + 1 == input.len() {
                return (visible, text(index, input.len()));
            }
            let Some(end) = escape_end(&input, index + 1) else {
                return (visible, text(index, input.len()));
            };
            visible.push_str(&text(index, end));
            index = end;
            continue;
        }
        visible.push(c);
        index += 1;
    }
    (visible, String::new())
}
fn is_csi_final(c: char) -> bool {
    ('\u{40}'..='\u{7e}').contains(&c)
}
fn all_in(body: &str, allowed: &str) -> bool {
    body.chars()
        .all(|c| c.is_ascii_digit() || allowed.contains(c))
}
fn strip_csi(body: &str, last: char) -> bool {
    match last {
        'n' => true,
        'R' => all_in(body, ";?"),
        'c' => all_in(body, ">;?"),
        // DECRQM queries and DECRPM replies. The `$` guard keeps DECSTR (!p) and DECSCL ("p).
        'p' | 'y' => body.strip_suffix('$').is_some_and(|b| all_in(b, ";?")),
        // XTVERSION. DECSCUSR (space-intermediate q) stays.
        'q' => body.strip_prefix('>').is_some_and(|b| all_in(b, ";")),
        // Kitty keyboard query and reply. Restore-cursor (bare u) stays.
        'u' => body.starts_with('?'),
        _ => false,
    }
}
/// DECRQSS ($q) and XTGETTCAP (+q) queries and their replies ([01]$r, [01]+r).
fn strip_dcs(content: &str) -> bool {
    let content = content.strip_prefix(['0', '1']).unwrap_or(content);
    let mut chars = content.chars();
    matches!(chars.next(), Some('$' | '+')) && matches!(chars.next(), Some('q' | 'r'))
}
/// Foreground, background, and cursor color queries and replies.
fn strip_osc(content: &str) -> bool {
    ["10;", "11;", "12;"].iter().any(|prefix| {
        content
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('?') || rest.starts_with("rgb:"))
    })
}
fn strip_string_terminator(value: &str) -> &str {
    value
        .strip_suffix("\u{1b}\\")
        .or_else(|| value.strip_suffix(['\u{7}', '\u{9c}']))
        .unwrap_or(value)
}
fn string_terminator(input: &[char], start: usize) -> Option<usize> {
    (start..input.len()).find_map(|i| match input[i] {
        '\u{7}' | '\u{9c}' => Some(i + 1),
        '\u{1b}' if input.get(i + 1) == Some(&'\\') => Some(i + 2),
        _ => None,
    })
}
fn escape_end(input: &[char], start: usize) -> Option<usize> {
    let cursor = (start..input.len()).find(|&i| !('\u{20}'..='\u{2f}').contains(&input[i]))?;
    Some(if ('\u{30}'..='\u{7e}').contains(&input[cursor]) {
        cursor + 1
    } else {
        start + 1
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitized(chunks: &[&str]) -> String {
        let mut pending = String::new();
        let mut visible = String::new();
        for chunk in chunks {
            let (text, rest) = sanitize(&pending, chunk);
            visible.push_str(&text);
            pending = rest;
        }
        assert_eq!(pending, "", "every sequence in the fixture completes");
        visible
    }

    #[test]
    fn strips_query_and_reply_sequences() {
        assert_eq!(
            sanitized(&[
                "prompt ",
                "\u{1b}[32mok\u{1b}[0m ",
                "\u{1b}]11;rgb:ffff/ffff/ffff\u{7}",
                "\u{1b}[1;1R",
                "done\n",
            ]),
            "prompt \u{1b}[32mok\u{1b}[0m done\n"
        );
    }
    #[test]
    fn strips_csi_and_dcs_traffic_while_preserving_setters() {
        assert_eq!(
            sanitized(&[
                "prompt ",
                "\u{1b}[?2026$p\u{1b}[?2026;2$y\u{1b}[>q\u{1b}[?u\u{1b}[?31u",
                "\u{1b}P$q m\u{1b}\\\u{1b}P1$r0m\u{1b}\\",
                "\u{1b}P+q544e\u{1b}\\\u{1b}P1+r544e=1b\u{1b}\\",
                "\u{90}$q m\u{9c}\u{90}1$r0m\u{9c}",
                "\u{90}+q544e\u{9c}\u{90}1+r544e=1b\u{9c}",
                "\u{1b}[!p\u{1b}[\"p\u{1b}[4 q\u{1b}[u",
                "done\n",
            ]),
            "prompt \u{1b}[!p\u{1b}[\"p\u{1b}[4 q\u{1b}[udone\n"
        );
    }
    #[test]
    fn handles_queries_split_across_chunks() {
        assert_eq!(
            sanitized(&[
                "before ",
                "\u{1b}[?2026$",
                "pafter ",
                "\u{1b}P$q ",
                "m\u{1b}",
                "\\after ",
                "\u{9b}?3",
                "1uafter ",
                "\u{90}+q544e",
                "\u{9c}after\n",
            ]),
            "before after after after after\n"
        );
    }
    #[test]
    fn keeps_clear_and_style_while_dropping_split_queries() {
        assert_eq!(
            sanitized(&[
                "before clear\n",
                "\u{1b}[H\u{1b}[2J",
                "prompt ",
                "\u{1b}]11;",
                "rgb:ffff/ffff/ffff\u{7}\u{1b}[1;1",
                "R\u{1b}[36mdone\u{1b}[0m\n",
            ]),
            "before clear\n\u{1b}[H\u{1b}[2Jprompt \u{1b}[36mdone\u{1b}[0m\n"
        );
    }
    #[test]
    fn keeps_escape_sequences_with_intermediate_bytes() {
        assert_eq!(
            sanitized(&["before ", "\u{1b}(B", "after\n"]),
            "before \u{1b}(Bafter\n"
        );
        assert_eq!(
            sanitized(&["before ", "\u{1b}(", "Bafter\n"]),
            "before \u{1b}(Bafter\n"
        );
    }
    #[test]
    fn carries_a_trailing_escape_into_the_next_chunk() {
        assert_eq!(sanitize("", "text\u{1b}"), ("text".into(), "\u{1b}".into()));
        assert_eq!(
            sanitize("", "a\u{1b}]8;;https://example.com"),
            ("a".into(), "\u{1b}]8;;https://example.com".into())
        );
    }

    /// T3's reference policy: keep the last `max_lines` lines, then the longest
    /// character-aligned tail within `max_bytes`.
    fn retained(text: &str, max_lines: usize, max_bytes: usize) -> String {
        let terminated = text.ends_with('\n');
        let mut lines: Vec<&str> = text.split('\n').collect();
        if terminated {
            lines.pop();
        }
        let kept = lines[lines.len().saturating_sub(max_lines)..].join("\n");
        let capped = if terminated { kept + "\n" } else { kept };
        let mut start = capped.len().saturating_sub(max_bytes);
        while !capped.is_char_boundary(start) {
            start += 1;
        }
        capped[start..].to_owned()
    }

    #[test]
    fn preserves_line_and_byte_limits_across_arbitrary_chunks() {
        let fragments = [
            "",
            "a",
            "\n",
            "\n\n",
            "\r",
            "\r\n",
            "café",
            "名",
            "🚀",
            "\u{1b}[31m",
            "\u{1b}[0m",
            "\u{1b}]8;;url\u{7}",
        ];
        let mut seed: u32 = 0x2026_0904;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            fragments[seed as usize % fragments.len()]
        };
        for max_bytes in [3, 8, 64, usize::MAX] {
            for max_lines in [1, 3, 5, 5_000] {
                let mut history = History::new(max_lines, max_bytes);
                history.append("before\ninitial\n");
                let mut expected = retained("before\ninitial\n", max_lines, max_bytes);
                assert_eq!(history.value(), expected);
                for _ in 0..300 {
                    let chunk = format!("{}{}", next(), next());
                    history.append(&chunk);
                    expected = retained(&(expected + &chunk), max_lines, max_bytes);
                    assert_eq!(
                        history.value(),
                        expected,
                        "lines={max_lines} bytes={max_bytes}"
                    );
                }
            }
        }
    }
    #[test]
    fn bounds_long_partial_lines() {
        let max_bytes = 65_539;
        let mut history = History::new(5_000, max_bytes);
        let mut expected = String::new();
        for text in [
            "a".repeat(16_383) + "😀" + &"b".repeat(70_000),
            "\r".to_owned() + &"c".repeat(70_000),
            "\u{FEFF}".to_owned() + &"名".repeat(30_000),
        ] {
            history.append(&text);
            expected = retained(&(expected + &text), 5_000, max_bytes);
            assert_eq!(history.value(), expected);
            assert!(history.value().len() <= max_bytes);
        }
    }
    #[test]
    fn keeps_retained_lines_across_many_chunks() {
        for max_lines in [3, 5_000] {
            let mut history = History::new(max_lines, MAX_BYTES);
            let mut expected = String::new();
            for batch in 0..40 {
                let chunk: String = (0..300).map(|line| format!("{batch}:{line}\n")).collect();
                history.append(&chunk);
                expected = retained(&(expected + &chunk), max_lines, MAX_BYTES);
                assert_eq!(history.value(), expected);
            }
        }
    }
    #[test]
    fn caps_lines_without_losing_partial_or_empty_lines() {
        let mut history = History::new(3, MAX_BYTES);
        for chunk in ["line1\n", "\n", "line3", "-continued\nline4"] {
            history.append(chunk);
        }
        assert_eq!(history.value(), "\nline3-continued\nline4");
    }
    #[test]
    fn caps_bytes_on_a_character_boundary() {
        let mut history = History::new(5, 10);
        for chunk in ["a".repeat(32).as_str(), "😀\rEND"] {
            history.append(chunk);
        }
        assert_eq!(history.value(), "aa😀\rEND");
    }
    #[test]
    fn default_caps_are_five_thousand_lines_and_eight_mebibytes() {
        let mut history = History::default();
        for line in 0..6_000 {
            history.append(&format!("{line}\n"));
        }
        let value = history.value();
        assert_eq!(value.lines().count(), 5_000);
        assert!(value.starts_with("1000\n"));
        let mut history = History::default();
        let line = "x".repeat(2047) + "\n";
        for _ in 0..5_000 {
            history.append(&line);
        }
        assert_eq!(history.value(), line.repeat(MAX_BYTES / line.len()));
        let mut history = History::default();
        history.append(&"y".repeat(9 * 1024 * 1024));
        assert_eq!(history.value().len(), MAX_BYTES);
    }
    #[test]
    fn decode_carries_split_multibyte_sequences() {
        let mut carry = Vec::new();
        let rocket = "🚀".as_bytes();
        assert_eq!(decode(&mut carry, &[b'a', rocket[0], rocket[1]]), "a");
        assert_eq!(carry, &rocket[..2]);
        assert_eq!(decode(&mut carry, &rocket[2..]), "🚀");
        assert!(carry.is_empty());
        assert_eq!(decode(&mut carry, &[0xFF, b'b']), "\u{FFFD}b");
        assert_eq!(decode(&mut carry, "é".as_bytes()), "é");
    }
}
