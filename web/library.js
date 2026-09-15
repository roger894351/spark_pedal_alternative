// Tone library: stores unlimited tones in banks of 4, in the browser.
// Files import/export in Ignitron's JSON format so tones can move between the two.

const STORAGE_KEY = "spark-switch-library";
export const BANK_SIZE = 4;

// Ignitron JSON ("Name"/"Pedals") ⇄ our internal shape ("name"/"pedals").
export function fromFileFormat(raw) {
  if (!raw || typeof raw !== "object") throw new Error("not a tone");
  const pedals = raw.pedals ?? raw.Pedals;
  if (!Array.isArray(pedals)) throw new Error("tone has no pedals");
  return {
    uuid: raw.uuid ?? raw.UUID,
    name: raw.name ?? raw.Name ?? "Unnamed",
    version: raw.version ?? raw.Version ?? "0.7",
    description: raw.description ?? raw.Description ?? "",
    icon: raw.icon ?? raw.Icon ?? "icon.png",
    bpm: raw.bpm ?? raw.BPM ?? 120,
    pedals: pedals.map((p) => ({
      name: p.name ?? p.Name,
      isOn: p.isOn ?? p.IsOn ?? false,
      parameters: (p.parameters ?? p.Parameters ?? []).map(Number),
    })),
  };
}

export const toFileFormat = (tone) => ({
  PresetNumber: 127,
  UUID: tone.uuid,
  Name: tone.name,
  Version: tone.version,
  Description: tone.description,
  Icon: tone.icon,
  BPM: tone.bpm,
  Pedals: tone.pedals.map((p) => ({ Name: p.name, IsOn: p.isOn, Parameters: p.parameters })),
});

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map(fromFileFormat) : [];
  } catch {
    return []; // corrupt or unavailable storage: start empty rather than breaking the page
  }
}

export function save(tones) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tones.map(toFileFormat)));
    return true;
  } catch {
    return false; // private mode / quota: the session still works, it just won't persist
  }
}

export const bankCount = (tones) => Math.max(1, Math.ceil(tones.length / BANK_SIZE));

export const bankSlots = (tones, bank) =>
  Array.from({ length: BANK_SIZE }, (_, i) => tones[bank * BANK_SIZE + i] ?? null);

// Accepts one tone object or an array of them.
export function parseImport(text) {
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(fromFileFormat);
}
