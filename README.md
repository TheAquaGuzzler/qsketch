# qsketch

Mark up a screenshot and attach it to your next message in Claude Code.

When Claude builds a game or an app for you, a lot of feedback is visual:
"this button is too small", "move the coins counter left", "remove this
panel". qsketch adds a button above the message box in the Claude desktop app.
It opens a Paint-style editor: paste a screenshot, draw on it, number the
spots you mean, and attach the result to the message you are about to send.

## Install

Tell Claude: **"Install the plugin from https://github.com/TheAquaGuzzler/qsketch"**.
Or run it yourself:

```
claude plugin install qsketch --marketplace TheAquaGuzzler/qsketch
```

Then open a new chat (or type `/reload-plugins`).

- In a Claude Code terminal session you can also type
  `/plugin install qsketch --marketplace TheAquaGuzzler/qsketch`.
- In the desktop app without a `claude` command: click **+** next to the
  message box, then **Plugins**, **Add marketplace** with
  `TheAquaGuzzler/qsketch`, then **Add plugin**.

Requirements: on Windows, nothing extra (it uses the built-in PowerShell and
Microsoft Edge or Google Chrome). On macOS and Linux, [Node.js](https://nodejs.org)
18 or newer.

> **Claude, installing this for someone:** run the `claude plugin install`
> command above in a shell, then ask them to open a new chat. If there is no
> `claude` command, give them the desktop-app steps instead.

## Use

1. Capture part of the screen: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on
   Windows, <kbd>Cmd</kbd>+<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>4</kbd> on a Mac.
2. Click **Annotate screenshot** above the message box, or type `/qsk`.
   In a new, empty chat the app shows no button until the first message, so
   use `/qsk` there.
3. In the editor window, paste with <kbd>Ctrl</kbd>+<kbd>V</kbd> (or drop an
   image file, or use **Open image**).
4. Draw: arrows, boxes, highlights, labels and numbered markers. Describe each
   marker under **Notes for Claude**.
5. Click **Attach to message** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>), go back to
   Claude and send your message. The picture and your notes go with it, and
   the message ends with `📎 Annotated screenshot attached`.

Prefer a normal image attachment? Click **Copy** in the editor, then paste into
the message box with <kbd>Ctrl</kbd>+<kbd>V</kbd>.

## Tools

| Tool | Key | Notes |
| --- | --- | --- |
| Select | <kbd>V</kbd> | Click a mark to select it, drag to move. Delete removes it. Arrow keys nudge. |
| Pen | <kbd>B</kbd> | Shift draws a straight line. |
| Highlighter | <kbd>H</kbd> | See-through marker. Shift draws a straight line. |
| Arrow | <kbd>A</kbd> | Drag from the tail to the tip. Shift snaps the angle. |
| Rectangle | <kbd>R</kbd> | Shift makes a square. |
| Ellipse | <kbd>E</kbd> | Shift makes a circle. |
| Text | <kbd>T</kbd> | Click to type a label. Esc finishes. |
| Numbered marker | <kbd>N</kbd> | Places 1, 2, 3... Describe each one on the right. |
| Crop | <kbd>C</kbd> | Drag over the part to keep, then press Enter. |
| Eraser | <kbd>X</kbd> | Click or drag over marks to delete them. |

<kbd>1</kbd>-<kbd>8</kbd> pick a color, <kbd>[</kbd> <kbd>]</kbd> change the
size, <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo and
redo, <kbd>Ctrl</kbd>+<kbd>C</kbd> copies the image, <kbd>Ctrl</kbd>+<kbd>S</kbd>
saves a copy, <kbd>Ctrl</kbd>+wheel zooms, <kbd>Space</kbd>+drag pans.
Shortcuts work in any keyboard layout.

## Commands

- `/qsk` opens the editor.
- `/qsk clear` removes the screenshots waiting for your next message.
- `/qsk folder` opens the folder where attached screenshots are kept.

## Options

Set them in the plugin's settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `keepDays` | `7` | Delete attached screenshots after this many days. `0` keeps them. |
| `browser` | `auto` | Which browser opens the editor: `auto` tries Edge, then Chrome, then your default browser. |
| `showButton` | `true` | Show the button above the message box. Off means you use `/qsk`. |

## Privacy

Everything stays on your computer. Attached screenshots are kept in
`~/.claude/qsketch/attachments` and deleted after 7 days; use **Save** in the
editor to keep one anywhere. The editor talks only to a small helper process
on `127.0.0.1`, behind a random token that changes every session. Claude may
read files in the attachments folder without asking; everything else still
asks as usual.

## Authors

- [BenzoOnDaHood](https://github.com/BenzoOnDaHood)
- [SummerPain](https://github.com/SummerPain)

Made by [TheAquaGuzzler](https://github.com/TheAquaGuzzler), built together
with Claude.

## License

[MIT](LICENSE)
