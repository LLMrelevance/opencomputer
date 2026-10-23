// A minimal terminal screen model: replays a captured terminal byte stream
// (text, cursor movement, erases) onto a grid and returns the lines a person
// would see at the end. Full-screen TUIs such as `claude setup-token` draw
// with cursor addressing and only repaint the cells that changed, so the
// stream with escape codes stripped is not the text on the screen: a word can
// be split by cursor jumps, and a character already on screen from an earlier
// frame is never written again. Reading the final screen avoids both.
//
// Deliberately small: no scroll regions, alternate screen, or wide-character
// widths. Every code point is one cell. It is used to find a token on the
// screen, not to render.

export function renderTerminalScreen(stream: string, rows = 24): string[] {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  let saved = { row: 0, col: 0 };

  const line = (index: number): string[] => {
    while (lines.length <= index) lines.push([]);
    return lines[index]!;
  };
  const viewportTop = (): number => Math.max(0, lines.length - rows);
  const put = (character: string): void => {
    const target = line(row);
    while (target.length < col) target.push(" ");
    target[col] = character;
    col += 1;
  };
  const eraseLine = (mode: number): void => {
    const target = line(row);
    if (mode === 0) target.length = Math.min(target.length, col);
    else if (mode === 1) for (let i = 0; i <= col && i < target.length; i++) target[i] = " ";
    else target.length = 0;
  };

  const characters = Array.from(stream);
  for (let i = 0; i < characters.length; i++) {
    const character = characters[i]!;
    if (character === "\x1b") {
      const next = characters[i + 1];
      if (next === "[") {
        // CSI: parameters, intermediates, one final byte in @..~.
        let j = i + 2;
        let body = "";
        while (j < characters.length && !/[@-~]/.test(characters[j]!)) {
          body += characters[j]!;
          j += 1;
        }
        const final = characters[j];
        i = j;
        if (final === undefined) break;
        if (/^[?<>=]/.test(body)) continue; // private modes and queries
        const params = body.split(";").map((value) => Number.parseInt(value, 10));
        const n = (index = 0, fallback = 1): number => {
          const value = params[index];
          return value === undefined || Number.isNaN(value) || value === 0 ? fallback : value;
        };
        switch (final) {
          case "A": row = Math.max(0, row - n()); break;
          case "B": row += n(); break;
          case "C": col += n(); break;
          case "D": col = Math.max(0, col - n()); break;
          case "E": row += n(); col = 0; break;
          case "F": row = Math.max(0, row - n()); col = 0; break;
          case "G": case "`": col = n() - 1; break;
          case "d": row = viewportTop() + n() - 1; break;
          case "H": case "f": row = viewportTop() + n(0) - 1; col = n(1) - 1; break;
          case "K": eraseLine(Number.isNaN(params[0]!) ? 0 : params[0]!); break;
          case "J": {
            const mode = Number.isNaN(params[0]!) ? 0 : params[0]!;
            if (mode === 0) {
              eraseLine(0);
              lines.length = Math.min(lines.length, row + 1);
            } else if (mode === 1) {
              for (let r = 0; r < row; r++) line(r).length = 0;
              eraseLine(1);
            } else {
              const top = viewportTop();
              for (let r = top; r < lines.length; r++) line(r).length = 0;
            }
            break;
          }
          case "X": {
            const target = line(row);
            for (let k = col; k < col + n() && k < target.length; k++) target[k] = " ";
            break;
          }
          case "P": line(row).splice(col, n()); break;
          case "@": {
            const target = line(row);
            if (col < target.length) target.splice(col, 0, ...Array<string>(n()).fill(" "));
            break;
          }
          case "s": saved = { row, col }; break;
          case "u": ({ row, col } = saved); break;
          default: break; // SGR (m) and everything else do not move text
        }
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        // OSC / DCS / APC / PM / SOS: skip to BEL or ST. The text an OSC 8
        // hyperlink wraps is outside the sequence and is printed normally.
        let j = i + 2;
        while (
          j < characters.length &&
          characters[j] !== "\x07" &&
          !(characters[j] === "\x1b" && characters[j + 1] === "\\")
        ) j += 1;
        i = characters[j] === "\x07" ? j : j + 1;
        continue;
      }
      if (next === "7") saved = { row, col };
      else if (next === "8") ({ row, col } = saved);
      else if (next === "M") row = Math.max(0, row - 1);
      else if (next === "E") { row += 1; col = 0; }
      else if (next === "D") row += 1;
      else if (next === "(" || next === ")" || next === "#" || next === "%") i += 1;
      i += 1;
      continue;
    }
    if (character === "\r") col = 0;
    else if (character === "\n" || character === "\v" || character === "\f") row += 1;
    else if (character === "\b") col = Math.max(0, col - 1);
    else if (character === "\t") col = (Math.floor(col / 8) + 1) * 8;
    else if (character >= " " && character !== "\x7f") put(character);
    // other C0 controls (BEL, SI, SO, ...) do not print
  }
  return lines.map((cells) => cells.join("").replace(/\s+$/, ""));
}
