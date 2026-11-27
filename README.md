# Bill Tribble Music Map

Interactive static web application visualizing Bill Tribble's solo and collaborative music catalog from 2001 to 2026 across 8 Vibe clusters, an artistic Energy-Wave Era timeline, and harmonic/groove analytics.

- **Live site:** [https://billtribble.github.io/music-map/](https://billtribble.github.io/music-map/)
- **Audio hosting:** Lightweight Git repository (`< 2 MB`) backed by GitHub Releases (`audio-previews-v1` for 8-bar beat-aligned previews and `archive-downloads-v1` for pre-2015 full-length 320 kbps MP3 & lossless FLAC downloads).
- **Stack:** Vanilla HTML / CSS / Canvas + SVG / WebAudio (`js/data.js` generated from 549 deduplicated catalog tracks & MIDI analysis; zero framework dependencies).

## Interactive Views

### Maps
1. **Vibe Map (`#vibe` / `#similarity`)** — 8-cluster sonic similarity atlas with Euclidean nearest-node hit-testing, Starred track filter (`★`), floating cluster pills, and collapsible persistent audio preview card.
2. **Era Timeline (`#era`)** — Artistic Energy-Wave timeline mapping chronological eras (`2001–2026`) against sonic energy & groove intensity (horizontal on desktop, vertical on mobile).

### Harmony & Evolution Analysis
3. **Macro Harmony & Energy (`#macro-harmony`)** — Harmonic complexity, drum complexity, modal darkness, and Mixed In Key energy across eras and phases.
4. **Timeline Animator (`#timeline-player`)** — Bar-quantized audio deck synced to an animated 8-axis sonic radar and Circle of Fifths key gravity wheel.
5. **Era Comparator (`#era-compare`)** — Side-by-side comparison of any two eras or phases.
6. **Chord & Dyad Spectrum (`#chord-quality`)**, **Root Motion & Wheel (`#root-motion`)**, **12-Degree Modal Heatmap (`#modal-heatmap`)**, **Voicing Spread (`#voicing-spread`)**, and **JI & Gamelan Tunings (`#ji-gamelan`)**.
7. **Workflow (`#workflow`)**, **Groove & Tempo (`#groove`)**, **Melody & Space (`#melody`)**, **Audio Expressiveness (`#audio`)**, and **Synths & FX Palette (`#palette`)**.
