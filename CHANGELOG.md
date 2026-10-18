# Changelog

## 1.4.3

- Fixed the card art spilling out past the card: the blurred background escaped the rounded clip and covered the side panel and the hint text. The card now clips its contents properly. The cards are also marked `data-sanso-skip`.
- Card art and thumbnails are now drawn as CSS backgrounds instead of `<img>` elements, so plugins that restyle every image in Steam (3D Game Cases turned the portrait card art into 3D cases) can no longer touch them, whatever version of that plugin is installed.

## 1.4.2

- First GitHub release: release zip with a prebuilt `dist/`, GitHub Actions release workflow, README with screenshots.
- Same plugin code as the 1.4.2 zip; the rebuilt `dist/index.js` no longer contains local build paths.
- Installing it over an earlier version keeps your matches, ghosted games and cache.
