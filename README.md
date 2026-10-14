# CtrlEm Panel

A local page for sending CtrlEm commands. The receiver has to be running CtrlEm and must have turned on **Allow Script/API Access**. Only commands that person has enabled will go through.

The panel runs on your own computer. It does not upload your API key anywhere except to CtrlEm when it sends a command.

What changed since the last copy is in `CHANGELOG.md`.

## What you need

- [Node.js](https://nodejs.org), the current LTS is enough
- A CtrlEm API key from your Dashboard
- The other person online, with script access allowed

## Start

Double-click `Start Panel.bat`.

The window that opens is the panel. Leave it open while you use it. Closing it stops the panel. The page opens at http://127.0.0.1:4777/

The **Style** menu in the header switches between dark, light, bimbo, night city, and nature. The choice stays in that browser.

If that address is already in use, the script assumes the panel is running and just opens the page.

When a newer copy is on GitHub, **Update available** shows in the header. It replaces the program files. Your key, library, albums, sequences, and preview pictures stay. Close the panel and start it again, then refresh the page.

You can also start it from this folder with:

```
node server.js
```

## First run

1. Open **Settings**.
2. Paste your API key. It is stored in `config.json` in this folder. Treat that file like a password.
3. On the left, pick someone who is online, or type their control code.

## Sending

The command tabs send one command to everyone you have selected.

A **sequence** is an ordered list of images, videos, sounds, messages, blank screens, reaction tests, and lock input. **Edit** builds the list. **Send** plays a copy of that list, so the next sequence can be built while a send is still going. Press **Play** and the panel sends the copy in order. Leave this page open, and the other person has to leave CtrlEm running. The wait on each step is the pause before the next item. The shortest pause is 3 seconds. A blank screen is still once every 30 seconds for each person. Lock input and blank screen only run on a desktop.

**Pomf** on a selected person sends that person a Pomf link instead of a `u.pone.rs` link. The panel downloads that file and uploads it to Pomf the first time, then remembers the link. Other selected people still get the original link. A link that is not on `u.pone.rs`, such as one kept with **Save link** or a Catbox upload, is sent as it is. The sequence list does not change. Use this for someone whose CtrlEm cannot download `u.pone.rs`. If Pomf refuses a file, the panel waits 20 seconds and tries that file once more before sending. A second failure skips that person for that step. A web page, a missing file, or a file over 1 GB is not tried again.

## Files

New files upload one at a time. Pick the host above the drop area:

- **pone.rs** takes files up to 1 GB and keeps a normal file until it breaks their rules.
- **Catbox** takes files up to 200 MB. A link stays until the file goes 2 years without being opened. Catbox can block an address that uploads too fast. If that happens, switch to pone.rs. A new network address can make Catbox reachable again.

**Save link** stores a URL you already have. It does not download the file.

**Albums** only group the file list. They are not sequences. **Add all** copies the files you are currently looking at (the open album and the category filter) into the sequence. Links already in the sequence are skipped.

Click a file's name to rename it in the list. The link stays the same. This is most useful for sounds, which have no picture.

An image in the list is a small still picture. The panel makes that picture the first time the tile is on screen and keeps it in the `thumbs` folder. Rest on a picture to play that one image. A video stays as a title card until you click it.

## Files you should not share

These are created on your computer after you start using the panel. This copy does not include them.

- `config.json` holds the API key, favorites, and who gets Pomf links
- `library.json` holds saved file links
- `pomf-mirrors.json` holds the Pomf copy of a link, once one has been made
- `albums.json` holds album names and which files are in them
- `sequences.json` holds saved sequences
- `thumbs` holds the small preview pictures
