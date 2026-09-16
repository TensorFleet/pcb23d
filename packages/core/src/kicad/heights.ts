/**
 * Component body height heuristics. KiCad boards carry STEP/VRML model paths, not the models
 * themselves, so PCB23D draws each footprint as a box and guesses its height from the
 * footprint name (IPC-7351 names encode it) or the body size.
 */
export function estimateHeight(footprintName: string, bodyW: number, bodyH: number): number {
  const name = footprintName.split(":").pop() ?? footprintName;
  const n = name.toLowerCase();

  // IPC-7351: RESC1005X40N → 0.40 mm, SOIC127P600X175-8N → 1.75 mm, CAPC3216X140N → 1.40 mm
  const ipc = /x(\d{2,4})(?:n|m|l)?(?:-\d+)?(?:n|m|l)?$/i.exec(name) ?? /x(\d{2,4})[nml]\b/i.exec(name);
  if (ipc) {
    const v = Number(ipc[1]) / 100;
    if (v >= 0.1 && v <= 60) return v;
  }
  // Explicit heights in the name: "H10mm", "_H5.0mm", "L6.3mm_D2.5mm" (axial: D is body diameter)
  const h = /(?:^|[_\-\s])h(\d+(?:\.\d+)?)mm/.exec(n);
  if (h) return clamp(Number(h[1]), 0.2, 60);
  const dia = /_d(\d+(?:\.\d+)?)mm/.exec(n);
  if (dia && /axial|radial|horizontal|vertical|do-|cp_/.test(n)) return clamp(Number(dia[1]), 0.5, 40);

  const table: [RegExp, number][] = [
    [/0201|0402|1005metric|r_0402|c_0402|led_0402/, 0.4],
    [/0603|1608metric/, 0.55],
    [/0805|2012metric/, 0.9],
    [/1206|3216metric|1210|3225metric/, 1.2],
    [/2010|5025metric|2512|6332metric/, 1.4],
    [/sod-?123|sod-?323|sod-?523|sod-?923|sma\b|smb\b|smc\b/, 1.1],
    [/sot-?23|sot-?223|sot-?89|sc-?70|sot-?363|sot-?353|tsot/, 1.1],
    [/qfn|dfn|uson|wson|vqfn|tqfn|mlf|lga/, 0.9],
    [/bga|csp|wlcsp/, 1.0],
    [/tqfp|lqfp|qfp|pqfp/, 1.2],
    [/soic|so-?8|so-?14|so-?16|sop|tssop|msop|ssop|vssop|qsop|sot-?23-?[568]/, 1.4],
    [/dip|pdip|dil/, 4.0],
    [/to-?220|to-?247|to-?263|d2pak|dpak|to-?252/, 4.5],
    [/to-?92|to-?126/, 5.0],
    [/pinheader|pin_header|header|idc|pinsocket|pin_socket/, 8.5],
    [/jst|molex|picoblade|xh|ph_|connector|conn_|terminalblock|screwterminal/, 6.0],
    [/usb[-_]?c|usb_c|type-?c/, 3.2],
    [/usb|microusb|mini-?usb/, 4.0],
    [/rj45|rj-?45|ethernet/, 13.0],
    [/hdmi|displayport/, 6.0],
    [/sd_card|microsd|sdcard|tf_card/, 1.8],
    [/crystal|xtal|oscillator|osc_/, 1.2],
    [/cp_radial|radial|elko|electrolytic|c_radial/, 10.0],
    [/cp_elec|c_elec|cp_smd/, 6.0],
    [/inductor|choke|l_smd|xal|xfl|srr|srn|nr[0-9]{4}/, 3.0],
    [/relay/, 12.0],
    [/buzzer|speaker|piezo/, 8.0],
    [/button|switch|sw_|tact|push/, 4.0],
    [/potentiometer|trimmer|pot_/, 8.0],
    [/led_/, 1.0],
    [/fuse/, 3.0],
    [/antenna/, 1.0],
    [/battery|bat_|coin|cr2032|18650/, 6.0],
    [/module|esp32|esp8266|rp2040|nrf52|raspberry/, 3.2],
    [/display|oled|lcd|tft/, 4.0],
    [/transformer|xfmr/, 15.0],
    [/heatsink/, 12.0],
    [/screw|standoff|spacer/, 5.0],
  ];
  for (const [re, height] of table) if (re.test(n)) return height;

  const minDim = Math.min(bodyW, bodyH);
  return clamp(0.35 * minDim, 0.6, 5);
}

/** Footprints that should not get a body box (bare holes, test points, artwork). */
export function isBodilessFootprint(footprintName: string): boolean {
  const n = footprintName.toLowerCase();
  return /mount(ing)?hole|fiducial|logo|test[-_ ]?point|\btp[_-]|solder[-_]?jumper|net[-_ ]?tie|stitching|^.*:via|_via_|symbol|marking|label|silk|openhardware|kicad-logo/.test(
    n,
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
