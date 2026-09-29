// ui.js - the buttons, menus and text panels (everything that is not the picture).
// It also remembers your choices in the browser (localStorage), so the app
// starts with the same sensor size and target next time.

import { DEFAULT_SENSOR, PLACEMENTS } from './config.js';

const STORAGE_KEY = 'foreheadGuide.settings';

const DEFAULT_SETTINGS = {
  placementId: 'Fp1-Fp2',
  customLeft: 'Fp1',
  customRight: 'Fp2',
  mode: 'guide',            // 'guide' = look for the real sensor, 'preview' = only show the target
  voice: false,
  showAll: true,
  showUnwrapped: false,
  headCircumferenceCm: '',  // empty = estimate it from the face
  sensor: { ...DEFAULT_SENSOR },
};

// Which sensor measurements appear in the Settings panel.
const SENSOR_FIELDS = [
  ['podWidth', 'Pod width (mm)'],
  ['podHeight', 'Pod height (mm)'],
  ['stripLength', 'Strip length (mm)'],
  ['stripWidth', 'Strip width (mm)'],
  ['electrodeOffset', 'Centre → electrode (mm)'],
  ['stripAngle', 'Strip angle (°)'],
];

export class UI {
  constructor(handlers) {
    this.handlers = handlers;
    this.settings = loadSettings();
    this.el = new Proxy({}, { get: (_, id) => document.getElementById(String(id)) });
    this.build();
  }

  build() {
    // target menu
    this.el['placement'].innerHTML = PLACEMENTS
      .map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
    this.el['placement'].value = this.settings.placementId;
    this.el['placement'].onchange = (e) => this.change('placementId', e.target.value);

    // sensor measurements
    this.el['sensor-fields'].innerHTML = SENSOR_FIELDS.map(([key, label]) => `
      <label class="field"><span>${label}</span>
        <input type="number" data-sensor="${key}" step="0.5" value="${this.settings.sensor[key]}"></label>`).join('');
    for (const input of this.el['sensor-fields'].querySelectorAll('input')) {
      input.onchange = () => {
        const value = parseFloat(input.value);
        if (Number.isFinite(value)) {
          this.settings.sensor[input.dataset.sensor] = value;
          this.change();
        }
      };
    }

    this.el['custom-left'].onchange = (e) => this.change('customLeft', e.target.value);
    this.el['custom-right'].onchange = (e) => this.change('customRight', e.target.value);
    this.el['head-circumference'].value = this.settings.headCircumferenceCm;
    this.el['head-circumference'].onchange = (e) => this.change('headCircumferenceCm', e.target.value);
    this.el['show-all'].checked = this.settings.showAll;
    this.el['show-all'].onchange = (e) => this.change('showAll', e.target.checked);
    this.el['show-unwrapped'].checked = this.settings.showUnwrapped;
    this.el['show-unwrapped'].onchange = (e) => this.change('showUnwrapped', e.target.checked);

    this.el['btn-start'].onclick = () => this.handlers.onStart();
    this.el['btn-switch'].onclick = () => this.handlers.onSwitchCamera();
    this.el['btn-settings'].onclick = () => { this.el['settings'].hidden = false; };
    this.el['btn-close'].onclick = () => { this.el['settings'].hidden = true; };
    this.el['btn-reset'].onclick = () => {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      save(this.settings);
      this.build();
      this.handlers.onChange();
    };
    this.el['btn-mode'].onclick = () => this.change('mode', this.settings.mode === 'guide' ? 'preview' : 'guide');
    this.el['btn-voice'].onclick = () => {
      this.change('voice', !this.settings.voice);
      // Saying something inside the click is what allows speech later (phones require it).
      if (this.settings.voice) this.handlers.onVoiceOn();
    };

    this.refresh();
  }

  change(key, value) {
    if (key) this.settings[key] = value;
    save(this.settings);
    this.refresh();
    this.handlers.onChange();
  }

  refresh() {
    this.el['custom'].hidden = this.settings.placementId !== 'custom';
    this.el['btn-mode'].classList.toggle('on', this.settings.mode === 'preview');
    this.el['btn-mode'].querySelector('small').textContent = this.settings.mode === 'preview' ? 'preview' : 'guiding';
    this.el['btn-voice'].classList.toggle('on', this.settings.voice);
    this.el['btn-voice'].querySelector('span').textContent = this.settings.voice ? '🔊' : '🔇';
  }

  // Fill the two "custom pair" menus with every EEG position we know.
  fillPositions(names) {
    for (const [id, key] of [['custom-left', 'customLeft'], ['custom-right', 'customRight']]) {
      this.el[id].innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join('');
      this.el[id].value = this.settings[key];
    }
  }

  // The chosen target, as { left, right } or { center }.
  get preset() {
    const chosen = PLACEMENTS.find((p) => p.id === this.settings.placementId) ?? PLACEMENTS[0];
    if (chosen.id !== 'custom') return chosen;
    return { id: 'custom', left: this.settings.customLeft, right: this.settings.customRight };
  }

  setCard(guidance) {
    this.el['card'].dataset.state = guidance.state;
    this.el['card-arrow'].textContent = guidance.arrow
      ?? { perfect: '✓', aligned: '✓', preview: '👁', searching: '…' }[guidance.state] ?? '·';
    this.el['card-title'].textContent = guidance.title;
    this.el['card-detail'].textContent = (guidance.corrections ?? [])
      .map((c) => `${c.arrow} ${c.amount}`).join('    ') || (guidance.hint ?? '');
  }

  setFit(text, warn = false) {
    this.el['fit'].textContent = text;
    this.el['fit'].classList.toggle('warn', warn);
  }

  setStatus(text) { this.el['start-status'].textContent = text; }
  setHeadEstimate(text) { this.el['head-estimate'].textContent = text; }
  setDiagnostics(text) { this.el['diagnostics'].textContent = text; }
  hideStart() { this.el['start'].hidden = true; }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved, sensor: { ...DEFAULT_SENSOR, ...(saved.sensor || {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);      // private mode, storage disabled...
  }
}

function save(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* not important if it fails */ }
}
