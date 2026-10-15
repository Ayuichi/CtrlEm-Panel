# Changelog

## 2026-10-15

### Updates are signed

**Update available** now only installs an update that carries the author's signature, and checks every downloaded file against it. A changed or unsigned file on GitHub is refused and nothing is written. The update also refuses file names that Windows would read as your personal files, such as `Config.json`. Other websites can no longer show the panel inside a frame.

A copy older than this one cannot check signatures yet, so this update is the last one it installs without that check. Every later update is checked.

Close the panel and start it again so this can load, then refresh the page.

### Uploads are public

The README now says it plainly: files uploaded to pone.rs, Catbox, or Pomf can be opened by anyone with the link and cannot be deleted from the panel.

### The sequence list shows preview pictures

Each image or video in **Edit** and **Send** shows its saved preview beside the name. A reaction test with a reward image does the same. A sound, a message, a blank screen, or lock input stays a small mark. A file that has no preview yet keeps that mark until the file list has made one.

Refresh the page. This does not need the panel to be started again.

## 2026-10-14

### Album menus fill when the page opens

The album menus were staying on **All files** and **No album** until a new album was created. They now fill when the page opens. Preview pictures load as each tile comes on screen, so they no longer hold up that list.

Refresh the page. This one does not need the panel to be started again.

### A reaction test can include an image

**Reaction test** takes an image as the reward. Put it in **Reward image** on that tab, or press **Add reaction test** while an image link is set. They see the image if they pass. If they miss, their input locks. Leave the image empty and only the test runs. A reward image on `u.pone.rs` is copied to Pomf for a marked person, the same way as other files.

Close the panel and start it again so this can load, then refresh the page.

### A frame for each video

A video in the file list shows one frame, kept in the `thumbs` folder with the image previews. A play mark stays on it. Resting on a video does not play it. Click the file to load it in the send preview. An mkv stays a title card, because the browser cannot draw a frame from it.

Close the panel and start it again so this can load, then refresh the page.

### Update from GitHub

When the page opens, the panel checks whether GitHub has a newer copy. **Update available** shows in the header when it does. The button downloads the program files. Your key, library, albums, sequences, and preview pictures stay where they are. Close the panel and start it again, then refresh the page.

### Still pictures in the file list

Each image in the file list shows a small still picture. The panel makes that picture the first time the tile is on screen, one file at a time, and then reuses it. Rest on a picture to play that one image. Videos in the list stay as a title card. Clicking a file still loads it in the send preview.

Close the panel and start it again so this can load, then refresh the page. A `thumbs` folder is created beside the panel. Leave it there. Do not send it to anyone.

### Reaction test, and more sequence steps

**Reaction test** is a command tab. The other person has to allow it. An image can go with it, as described above.

A sequence can also include a **message**, a **blank screen**, a **reaction test**, and **lock input**. Add message uses the text in the Message box. Blank screen and lock input are desktop only. A blank screen is still once every 30 seconds per person, and a sooner blank in the same run is skipped for that person.

Close the panel before unzipping this over an older copy. Leave `config.json`, `library.json`, `albums.json`, `sequences.json`, and a `thumbs` folder where they are. Start the panel again and refresh the page.

### Edit and Send are separate

The sequence area has two tabs. **Edit** builds and saves the list. **Send** plays a copy of that list. After Play, Edit can start the next sequence while the send continues. The progress line stays visible on both tabs. One sequence plays at a time.

## 2026-10-13

### Pomf links for one person

A **Pomf** button on a selected person sends that person a Pomf link. Everyone else still selected gets the original link. The sequence list does not change.

The panel downloads the file and uploads it to Pomf the first time that link is sent to a marked person. The Pomf address is remembered, so a later send of the same link does not upload it again. New uploads still go to the host selected above the file list. pone.rs stays the default.

Use this for someone whose CtrlEm cannot download `u.pone.rs`.

A link that is not on `u.pone.rs` is not copied. That includes a link kept with **Save link**, and a file uploaded to Catbox. The marked person gets that same link. Only `u.pone.rs` files are uploaded to Pomf.

### A refused Pomf copy is tried once more

If Pomf refuses a file while a sequence is being prepared, the panel finishes the first pass, waits 20 seconds, and copies only the refused files once more before sending. A file that succeeds on the second try is sent. A file that fails again is skipped for the marked person. The other selected people still get the original link.

A single send does the same for that one file: one wait, one more try.

A web page, a missing file, or a file over 1 GB is not tried again.

### Rename a saved file

Click a file's name in the list to rename it. A pencil sits on the name. The link stays the same. Enter saves the name, and Escape puts the old name back. A blank name is refused.

A sequence step keeps the name it had when you added it. Adding that file again uses the new name.

### Updating an older copy

Close the panel. Unzip this over the old folder. Leave these files where they are if you already have them:

- `config.json`
- `library.json`
- `albums.json`
- `sequences.json`
- `thumbs`, once the panel has made any preview pictures

Start the panel again with `Start Panel.bat` and refresh the page. `pomf-mirrors.json` is created on your computer the first time a Pomf copy is made. The `thumbs` folder is created the first time a still picture is made. Do not send either of those to anyone.
