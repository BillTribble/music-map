# Bill-Music Evolution Explorer

Interactive static web application visualizing how Bill's music-making evolved from 2013 to 2026 across **229 unique projects** (`1,543` deduplicated MIDI clips and `448` FFT-YIN pitched audio parts).

- **Live site:** https://billtribble.github.io/music-evolution/
- **Stack:** Vanilla HTML / CSS / SVG / WebAudio (`data.js` built from corpus JSON distributions using pure Python 3 stdlib; zero external CDNs).

## Interactive Views

### Harmony & Microtonal Deep-Dive
1. **Chord & Dyad Spectrum (`#chord-quality`)** — Separates dyads (`P5`, `P4`, `3rd/6th`, `2nd/b7`, `b2/M7`, `tritone`) from tertian, suspended, seventh (`maj7`, `min7`, `dom7`), extended (`9th/11th`), and quartal/cluster voicings across all 12 eras.
2. **Root Motion & Wheel (`#root-motion`)** — Tracks harmonic progression intervals (`±1` Phrygian slides, `±2` whole-step planing, `±3`/`±4` mediants, `±5` fourths/fifths, `0 st` pedal repeat) alongside an interactive 12-semitone transition wheel.
3. **12-Degree Modal Heatmap (`#modal-heatmap`)** — Compares tonic, color degrees (`b2`, `2`, `b3`, `3`, `6`, `b7`, `7`), and audio-vs-MIDI modality across eras.
4. **Voicing Spread & Keyboard (`#voicing-spread`)** — Plots chord pitch ranges (`low_p25–high_p75`, `low_p50–high_p50`) and semitone spans (`p10–p90`) over a `C1–C6` keyboard staff.
5. **JI & Gamelan Tunings (`#ji-gamelan`)** — Surfaces Garage-era microtonal (`Retune for Live`, `Retune microtonal simple JI`, `AfroDJMac Tuned 808 JI`, `Imposcar micro 6th chord`) and Balinese *Semaradana* / Gamelan usage, acoustic cent deviations from 12-TET (`36,761` audio notes), and an interactive `0–1200¢` WebAudio octave cent-ruler.
6. **Era-vs-Era Comparator (`#era-compare`)** — 8-axis harmonic radar, 12-degree butterfly chart, and Circle-of-Fifths root-gravity comparison.

### Track & Sound Evolution
7. **Workflow (`#workflow`)** — MIDI vs. audio pitched notes and track balance.
8. **Groove & Tempo (`#groove`)** — Drum/bass/pitched quantization rates, tempo IQR bands, and syncopation.
9. **Melody & Space (`#melody`)** — Stepwise motion, leap-then-step gap-fill, register shifts, and rest space.
10. **Audio Expressiveness (`#audio`)** — Acoustic audio source mix, legato phrasing, and pitch vibrato/bend depth.
11. **Synths & FX (`#palette`)** — Signature instruments and effects per era/phase.
