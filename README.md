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

When a newer copy is on GitHub, **Update available** shows in the header. It replaces the program files. The panel only accepts an update signed by the author, and checks every file against that signature before writing anything. Your key, library, albums, sequences, and preview pictures stay. Close the panel and start it again, then refresh the page.

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

A **sequence** is an ordered list of images, videos, sounds, wallpapers, pages, messages, writes, blank screens, reaction tests, and lock input. **Edit** builds the list. **Add write** and **Add open page** are always on that bar. **Add image**, **Add video**, **Add sound**, and **Add wallpaper** follow the command tab. Click a step to add the next one after it. Change a message or a write in its row. Drag a step by the row: the row stays put, a faint copy follows the pointer, and the step moves when you let go. **Send** plays a copy of that list, so the next sequence can be built while a send is still going. A write types into the active window, up to 200 characters, and can repeat from 1 to 5 times. Wallpaper, video, lock input, and blank screen only run on a desktop. An open-page step is not copied to Pomf. An image or video that already has a preview picture shows that picture beside its name in both lists. A reaction test with a reward image does the same. On **Send**, click a step and **Play** starts there. Click that step again to start from the beginning. **Stop** leaves that step marked. With no step clicked, **Play** sends the copy from the beginning. Leave this page open, and the other person has to leave CtrlEm running. The wait on each step is the pause before the next item. The shortest pause is 3 seconds. A blank screen is still once every 30 seconds for each person.

A **reaction test** can include an image. Put that image in **Reward image**, or use **Add reaction test** while an image link is set. They see the image if they pass. If they miss, their input locks. Leave the image empty and only the test runs. A reward image on `u.pone.rs` is copied to Pomf for a marked person, the same way as other files.

**Pomf** on a selected person sends that person a Pomf link instead of a `u.pone.rs` link. The panel downloads that file and uploads it to Pomf the first time, then remembers the link. Other selected people still get the original link. A link that is not on `u.pone.rs`, such as one kept with **Save link** or a Catbox upload, is sent as it is. The sequence list does not change. Use this for someone whose CtrlEm cannot download `u.pone.rs`. A sequence that starts at a later step copies only the files from that step on. If Pomf refuses a file, the panel waits 20 seconds and tries that file once more before sending. A second failure skips that person for that step. A web page, a missing file, or a file over 1 GB is not tried again.

## Files

**Uploads are public.** pone.rs, Catbox, and Pomf are anonymous public hosts. Anyone who has the link can open the file, and anyone you send it to has the link. The panel cannot delete an upload, and neither host gives you a way to. pone.rs keeps files with no end date. A Pomf copy for a marked person is a second public copy. Do not upload anything you would not want to stay online, such as a picture of your face or anything that identifies you.

New files upload one at a time. Pick the host above the drop area:

- **pone.rs** takes files up to 1 GB and keeps a normal file until it breaks their rules.
- **Catbox** takes files up to 200 MB. A link stays until the file goes 2 years without being opened. Catbox can block an address that uploads too fast. If that happens, switch to pone.rs. A new network address can make Catbox reachable again.

**Save link** stores a URL you already have. It does not download the file.

**Albums** only group the file list. They are not sequences. The album menus are alphabetical. **Add all** copies the files you are currently looking at (the open album and the category filter) into the sequence. Links already in the sequence are skipped.

Click a file's name to rename it in the list. The link stays the same. This is most useful for sounds, which have no picture.

An image or a video in the list is a small still picture. The panel makes that picture the first time the tile is on screen and keeps it in the `thumbs` folder. Rest on a picture to play that one image. A video shows one frame, with a play mark, and does not play from the tile. An mkv stays a title card. Click a file to load it in the send preview.

## Files you should not share

These are created on your computer after you start using the panel. This copy does not include them.

- `config.json` holds the API key, favorites, and who gets Pomf links
- `library.json` holds saved file links
- `pomf-mirrors.json` holds the Pomf copy of a link, once one has been made
- `albums.json` holds album names and which files are in them
- `sequences.json` holds saved sequences
- `thumbs` holds the small preview pictures

## Publishing your own copy

You only need this if you fork the panel and want to ship updates yourself.

**Update available** reads `build.json` from `main` on `Ayuichi/CtrlEm-Panel` (`UPDATE_REPO` in `server.js`) and only accepts it when it is signed by the key in `UPDATE_PUBLIC_KEY`. A fork needs its own key:

1. `node tools/sign-build.js --init` makes a key pair. The private key goes to `.ctrlem-panel/signing-key.pem` in your user folder, outside the panel folder. Back it up and never share or commit it.
2. Put the printed public key in `UPDATE_PUBLIC_KEY` and your repo in `UPDATE_REPO`.
3. For each release, raise `version` in `build.json`, run `node tools/sign-build.js`, and commit `build.json` together with the files it lists. Editing any of those files afterwards needs a new signature.

`tools/` is not part of the update. People running the panel do not need it.
