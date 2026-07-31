/**
 * Input packet construction.
 *
 * Every packet opens with the same 8-byte header, and its two fields disagree
 * about byte order — `size` is BIG endian, `magic` is LITTLE endian. That is
 * not a transcription error here; it is what the protocol does, and mixing them
 * up produces packets the host drops without complaint.
 *
 * `size` counts everything after itself: the magic plus the body.
 *
 * The magics are the gen-5+ variants, which is what any Sunshine host speaks.
 * The older values differ for exactly the mouse and scroll events, so using the
 * pre-gen-5 numbers gives a session where the keyboard works and the mouse
 * silently does nothing.
 */

const KEY_DOWN = 0x00000003;
const KEY_UP = 0x00000004;
const MOUSE_MOVE_ABS = 0x00000005;
const MOUSE_MOVE_REL = 0x00000007;   // gen5+; 0x06 on older hosts
const MOUSE_BUTTON_DOWN = 0x00000008;
const MOUSE_BUTTON_UP = 0x00000009;
const SCROLL = 0x0000000a;           // gen5+; 0x09 on older hosts
const HSCROLL = 0x55000001;          // Sunshine extension
const UTF8_TEXT = 0x00000017;
const MULTI_CONTROLLER = 0x0000000C;   // gen5+

// Fixed values the host checks; they are not flags and must be sent verbatim.
const MC_HEADER_B = 0x001a;
const MC_MID_B = 0x0014;
const MC_TAIL_A = 0x009c;
const MC_TAIL_B = 0x0055;

// Button ids the host expects.
const BUTTON_LEFT = 0x01;
const BUTTON_MIDDLE = 0x02;
const BUTTON_RIGHT = 0x03;
const BUTTON_X1 = 0x04;
const BUTTON_X2 = 0x05;

// Gamepad buttons. The high half maps Sunshine's paddle/touchpad extension.
const BUTTONS_GAMEPAD = {
    UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
    PLAY: 0x0010, BACK: 0x0020, LS_CLK: 0x0040, RS_CLK: 0x0080,
    LB: 0x0100, RB: 0x0200, SPECIAL: 0x0400,
    A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
    PADDLE1: 0x010000, PADDLE2: 0x020000, PADDLE3: 0x040000, PADDLE4: 0x080000,
    TOUCHPAD: 0x100000,
};

// Modifier bits for the keyboard packet.
const MOD_SHIFT = 0x01;
const MOD_CTRL = 0x02;
const MOD_ALT = 0x04;
const MOD_META = 0x08;

/** Build a packet: BE size, LE magic, then the body. */
function packet(magic, body = Buffer.alloc(0)) {
    const buf = Buffer.alloc(8 + body.length);
    buf.writeUInt32BE(4 + body.length, 0);   // everything after this field
    buf.writeUInt32LE(magic >>> 0, 4);
    body.copy(buf, 8);
    return buf;
}

/** Relative pointer motion, which is what a captured mouse sends. */
function mouseMoveRelative(deltaX, deltaY) {
    const body = Buffer.alloc(4);
    body.writeInt16BE(clampShort(deltaX), 0);
    body.writeInt16BE(clampShort(deltaY), 2);
    return packet(MOUSE_MOVE_REL, body);
}

/**
 * Absolute pointer position. `width`/`height` are the reference frame the host
 * scales against — pass the video's dimensions, not the canvas element's, or
 * the pointer lands somewhere proportionally wrong.
 */
function mouseMoveAbsolute(x, y, width, height) {
    const body = Buffer.alloc(10);
    body.writeInt16BE(clampShort(x), 0);
    body.writeInt16BE(clampShort(y), 2);
    body.writeInt16BE(0, 4);                 // unused
    body.writeInt16BE(clampShort(width), 6);
    body.writeInt16BE(clampShort(height), 8);
    return packet(MOUSE_MOVE_ABS, body);
}

function mouseButton(down, button) {
    const body = Buffer.alloc(1);
    body.writeUInt8(button, 0);
    return packet(down ? MOUSE_BUTTON_DOWN : MOUSE_BUTTON_UP, body);
}

/** Vertical wheel. The amount is in the same units a wheel notch reports. */
function scroll(amount) {
    const body = Buffer.alloc(6);
    body.writeInt16BE(clampShort(amount), 0);
    body.writeInt16BE(clampShort(amount), 2);
    body.writeInt16BE(0, 4);
    return packet(SCROLL, body);
}

function horizontalScroll(amount) {
    const body = Buffer.alloc(2);
    body.writeInt16BE(clampShort(amount), 0);
    return packet(HSCROLL, body);
}

/**
 * A key event. `keyCode` is a Windows virtual-key code — the host is speaking
 * Windows' vocabulary regardless of what it runs on.
 */
function keyboard(down, keyCode, modifiers = 0) {
    const body = Buffer.alloc(6);
    body.writeUInt8(0, 0);                   // flags; Sunshine extension, 0 for GFE
    body.writeInt16LE(keyCode, 1);
    body.writeUInt8(modifiers, 3);
    body.writeInt16LE(0, 4);
    return packet(down ? KEY_DOWN : KEY_UP, body);
}

/** Typed text, for anything the virtual-key path cannot express. */
function utf8Text(text) {
    const encoded = Buffer.from(String(text), 'utf8').subarray(0, 32);
    return packet(UTF8_TEXT, encoded);
}

/**
 * Gamepad state. Unlike the other events this is a whole-controller snapshot,
 * not a delta — the host holds whatever was last sent, so a dropped update is
 * self-correcting but a missing one leaves a stick deflected.
 *
 * `activeGamepadMask` tells the host which pads exist at all; without the bit
 * for this controller set, the packet is accepted and ignored.
 *
 * @param {number} index          controller number, 0-3
 * @param {number} buttons        bitmask, see BUTTONS_GAMEPAD
 * @param {{leftTrigger,rightTrigger,leftStickX,leftStickY,rightStickX,rightStickY}} axes
 * @param {number} activeMask     bitmask of connected controllers
 */
function gamepad(index, buttons, axes = {}, activeMask = 1) {
    const body = Buffer.alloc(28);
    let o = 0;
    body.writeInt16LE(MC_HEADER_B, o); o += 2;
    body.writeInt16LE(index, o); o += 2;
    body.writeInt16LE(activeMask, o); o += 2;
    body.writeInt16LE(MC_MID_B, o); o += 2;
    body.writeUInt16LE(buttons & 0xffff, o); o += 2;
    body.writeUInt8(clampByte(axes.leftTrigger), o); o += 1;
    body.writeUInt8(clampByte(axes.rightTrigger), o); o += 1;
    body.writeInt16LE(clampShort(axes.leftStickX), o); o += 2;
    body.writeInt16LE(clampShort(axes.leftStickY), o); o += 2;
    body.writeInt16LE(clampShort(axes.rightStickX), o); o += 2;
    body.writeInt16LE(clampShort(axes.rightStickY), o); o += 2;
    body.writeInt16LE(MC_TAIL_A, o); o += 2;
    // Sunshine extension carrying paddles and the touchpad button.
    body.writeUInt16LE((buttons >>> 16) & 0xffff, o); o += 2;
    body.writeInt16LE(MC_TAIL_B, o); o += 2;
    return packet(MULTI_CONTROLLER, body);
}

function clampByte(value) {
    const n = Math.round(Number(value) || 0);
    return Math.max(0, Math.min(255, n));
}

function clampShort(value) {
    const n = Math.round(Number(value) || 0);
    return Math.max(-32768, Math.min(32767, n));
}

module.exports = {
    mouseMoveRelative,
    mouseMoveAbsolute,
    mouseButton,
    scroll,
    horizontalScroll,
    keyboard,
    utf8Text,
    gamepad,
    BUTTONS_GAMEPAD,
    BUTTONS: { BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, BUTTON_X1, BUTTON_X2 },
    MODIFIERS: { MOD_SHIFT, MOD_CTRL, MOD_ALT, MOD_META },
};
