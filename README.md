## Simulacra

is an Open-Source Project that aims to create a comprehensive geometric map of all the security/surveillance cameras on the West Coast. Users can upload pictures of security cameras not yet on the site, an AI will determine the image's validity slash location, and the information will be updated, thanks to the user's help! We hope this will become more of a community-led project more than just a pretty scraper. The website currently only works in 2D mode and has a litany of features (such as vision cones, radii of vision corresponding to specific security camera models). We hope to add + improve upon the existing 3D map as well.

---

## ⚠️ Legal disclaimer

This README is not legal advice. The project is a civic-tech / journalism /
research tool; whether you can lawfully run, host, or contribute to it depends
on **where you are** and **what you do with it**. We are not responsible for any unwanted user action.

### Data source

- **OpenStreetMap** — © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright). Attribution shown on map.
- **Caltrans CCTV** — California public records. Attribution credited.
- **San Diego CityIQ snapshot** — derived from City of San Diego open data via
  a third-party GitHub gist.
- **Anthropic Claude API** — usage governed by Anthropic's
  [usage policies](https://www.anthropic.com/legal/aup).

### Jurisdictional notes

- **United States** — photographing things visible from public spaces
  (cameras on poles, buildings, street furniture) is broadly protected by the
  First Amendment. Mapping their locations has been done publicly for years
  (e.g. EFF's Atlas of Surveillance) without successful legal challenge.
- **Camera operators' rights** — operators (police, businesses, homeowners)
  do not generally have a privacy right in a camera that is itself observable
  from public space. They _do_ have rights if you publish photos of the
  operator, the inside of a private residence, etc.

### Takedown policy

> To request removal of a camera, email **solomon@ucsd.edu** with the camera ID
> (visible in the popup) or a screenshot. We aim to respond within 7 days.

### What this project is _not_

- A tool for stalking, harassing, or targeting individuals.
- A guide to disabling, vandalizing, or evading cameras.
- A substitute for legal advice in your jurisdiction.

Submissions that look like any of the above (photos of people, license plates
of private vehicles, or messages targeting specific individuals) will be reviewed manually and swiftly removed.

## How images are handled

**Submitted photos are never stored.**

### Full flow for an uploaded photo

1. You pick or capture a photo in the browser.
2. The image is **resized to max 1600px** on the long edge and **re-encoded
   as JPEG** through a `<canvas>` -> this strips most of the metadata. .
3. The stripped, resized image is sent **as inline base64** to the Edge
   Function. There is no public facing URL.
4. The Edge Function forwards the base64 to Anthropic's Claude vision API
   for classification. Per Anthropic's
   [commercial terms](https://www.anthropic.com/legal/commercial-terms), API
   requests are not used to train models and are retained up to **30 days**
   for trust-and-safety review.
5. Only the AI's classification — `type`, `brand`, `model`, confidence score,
   one-sentence reason — is saved to the database. The image bytes are
   discarded the moment Claude responds.
6. Popups show the camera dot with the AI's reason text. There is no photo
   to display.

### What this means in practice

- If you accidentally include a face, a license plate, or your own house in
  the background of a submitted photo, **the photo does not and will never end up indexed on
  the clearnet**.
- We will never show the photos in UI.
