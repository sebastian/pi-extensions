# vim-mode

A more capable vim-style modal editor for pi.

## What it supports

- normal + insert modes
- counts like `3w`, `2dw`, `4j`
- motions: `h`, `j`, `k`, `l`, `w`, `W`, `b`, `B`, `e`, `E`, `ge`, `gE`, `0`, `^`, `$`, `gg`, `G`, `%`
- find motions: `f`, `F`, `t`, `T`, repeat with `;` and `,`
- insert/edit commands: `i`, `a`, `I`, `A`, `o`, `O`, `x`, `X`, `s`, `S`, `r`, `J`, `u`
- operators: `d`, `c`, `y` with the motions above
- text objects for operators:
  - words: `iw`, `aw`, `iW`, `aW`
  - quotes: `i"`, `a"`, `i'`, `a'`, ``i` ``, ``a` ``
  - delimiters: `i(`, `a(`, `i[`, `a[`, `i{`, `a{`, `i<`, `a<`
- linewise variants: `dd`, `cc`, `yy`, `D`, `C`, `Y`
- paste with `p` and `P`
- vim-like `cw` special-casing so changing a word usually does not swallow the following space

## Notes

- The editor starts in **insert** mode so the chat input stays convenient.
- `Esc` leaves insert mode. In normal mode, `Esc` still aborts pi when no vim sub-command is pending.
- Arrow keys still work for basic navigation in normal mode.
- This is intentionally not a full Vim clone yet, but it covers a much larger and more useful navigation/editing surface.
