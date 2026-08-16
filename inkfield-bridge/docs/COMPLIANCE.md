# InkField License Compliance Memo

**Purpose of this document:** to explain, in plain language, what we built on top
of InkField (https://ileivoivm.github.io/inkField/, by Aluan Wang) and why we
believe it fits within the terms of InkField's "Open Creative License," for
anyone reviewing this — including the author or outside counsel — who does not
need or want our internal engineering vocabulary to evaluate it.

This document describes what the system actually does, in terms that map
directly onto the license's own wording, which is quoted throughout so nothing
here has to be taken on faith.

---

## 1. What we built, in one paragraph

We built a small internal service that lets our automated conversational
assistants ("the assistants") create paintings using InkField, and that lets a
human on our side submit a painting they made in InkField so an assistant can
see it too. Nothing about InkField itself — its code, its visual design, its
web page — is copied, stored, or re-hosted by us anywhere. Every painting is
still produced by the actual InkField application running at its one real,
public web address, exactly as it would if a person opened that page in an
ordinary browser and used it by hand. Our software's role is limited to filling
in the on-screen actions a person would otherwise take (drawing strokes,
choosing a color, pressing the buttons InkField itself provides for exactly
this purpose — more on that below) and then saving a copy of the resulting
picture, the same as anyone using InkField normally would with a screenshot or
the app's own "save image" button.

## 2. The license's own permitted list, and how we fit it

InkField's license states:

> "What you ARE welcome to do: View and clone the repository for personal
> study. Use the published web application for any purpose, including
> creating artworks for sale... Submit paintings to the public gallery. File
> bug reports, feature requests, and documentation PRs."

Our system's activity maps onto the second item, "use the published web
application for any purpose," and only that item:

- Every painting is produced by loading InkField's real, live web page — the
  one at `https://ileivoivm.github.io/inkField/`, published and hosted by the
  author — and never a copy of it.
- Our software automates the same actions a person takes on that page: it
  fills in the on-screen drawing controls, presses the same buttons a human
  would, and reads back the resulting picture. This is functionally the same
  thing as a person using the site directly; we've simply written a program
  to press the buttons instead of a hand doing it.
- Notably, InkField's own web page **already contains built-in features
  written specifically for this exact kind of automated use** — a function
  named `window.inkfieldSnapshot()` (documented in the page's own source as
  something "AI agents can also call... to get a data URL"), and a full
  written guide, hosted on InkField's own site, titled for AI agents and
  explaining exactly how to compose a painting programmatically. We use these
  built-in features rather than working around them. In other words, the
  author designed the published application to support this exact use case,
  and our system uses it the way it was designed to be used.
- We separately keep a private, read-only copy of InkField's repository, but
  only to read the author's own written documentation of how the picture-data
  format works — the same way a person would read a manual. That copy is
  never run, never served to anyone, and nothing from it is copied into
  anything we distribute or operate.

## 3. The license's reserved list, and why none of it applies to us

The license reserves several categories of use:

> "Anything beyond the list above — redistribution, forking as a separate
> product, integrating the rendering engine into another application, or
> building a derivative codebase — is reserved."

Taking each in turn, in plain terms:

- **Redistribution** — we do not give anyone a copy of InkField's software.
  Nobody using our system ever receives InkField's code; they only ever see
  the pictures it produces, exactly as if they had visited InkField's own
  page themselves.
- **Forking as a separate product** — we have not copied InkField's project,
  renamed it, or offered it as our own product. We built something different
  — an assistant capability — that happens to call InkField's real website to
  do the drawing.
- **Integrating the rendering engine into another application** — this is the
  one we were most careful about, because an earlier internal draft of this
  system did come close to doing exactly this: at one point, for convenience,
  our software briefly ran its own private copy of InkField's page on our own
  server instead of using the real one. We caught this ourselves before it
  was ever used for anything, and rebuilt the system so that it never runs a
  copy of InkField at all — every picture is produced by the one real,
  public InkField page, the same page anyone else uses. What remains today
  does not embed, host, or operate any version of InkField's software; it
  only calls the author's own live website, the same way a browser does.
- **Building a derivative codebase** — none of InkField's own code, wording,
  images, or visual design appears anywhere in our software. The only
  InkField-specific information we use is the shape of its picture-data
  format (for example, that a color is chosen by a numbered id, and which
  numbers correspond to which named colors) — this is documentation of a
  file format, published by the author specifically so outside programs can
  produce compatible files, not a copy of the program that reads it. This is
  the same relationship any program has to a file format it's designed to
  produce, such as a program that writes a spreadsheet file without
  containing any of the spreadsheet software's own code.

## 4. Ownership of the resulting pictures

The license states:

> "Paintings you create using inkField... belong to you: Full copyright
> belongs to the creator. Commercial use is expressly permitted: exhibit,
> sell, mint as NFT, license, or distribute without restriction. No royalty
> or revenue share is owed to the inkField project."

We understand and rely on this: any picture our assistants produce through
InkField belongs fully to us, may be used commercially without owing anything
back to the InkField project, and does not require any further permission.
As of this writing we have not sold, licensed, or minted any picture produced
this way — this section is included so the position is on record, not because
anything of the sort has happened yet.

## 5. The public gallery

The license's gallery terms (submitting a recording grants the project a
license to host and display it, submitter keeps copyright, removable on
request) apply only to submissions made through InkField's own public
gallery. We have not submitted anything to InkField's public gallery, and our
internal system for letting a human hand a painting to an assistant is a
private mechanism entirely on our own side — it does not touch, upload to, or
interact with InkField's public gallery in any way. If we ever do submit
something to the public gallery, the gallery's own terms would apply to that
submission automatically and without any special handling on our part.

## 6. Attribution

The license notes that crediting InkField ("Made with InkField") is
appreciated but not required. We do not present any picture produced this way
as something other than what it is, and are glad to include that credit
wherever these pictures are shown.

## 7. Bottom line

Every picture our system produces is made by the real, public InkField
application, used the way the author's own documentation says it's meant to
be used by an automated program, with nothing of InkField's own software
copied, hosted, modified, or handed to anyone else. We believe this is squarely
"use of the published web application," not any of the reserved categories,
and we've re-checked this understanding directly against the license text
above rather than assuming it.

Questions about this document, or about the system it describes, can be
directed to whoever shared it with you.
