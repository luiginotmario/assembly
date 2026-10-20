import { library } from './library';
import type { Guide, Part } from './types';

// A real build, done by hand once: two radar sensors wired to a Mac through two
// CP2102 USB adapters. Shown when someone wants to see the tool without an API key.

// straightened photos of the real boards used in this build, and where each pin sits on them
const photos: Record<string, { texture: string; at: Record<string, [number, number]> }> = {
  ld2450: { texture: '/example/ld2450.jpg', at: { '5V': [0.12, 0.37], RX: [0.12, 0.48], TX: [0.12, 0.58], GND: [0.12, 0.69] } },
  ld2410c: {
    texture: '/example/ld2410c.jpg',
    at: { TX: [0.22, 0.12], RX: [0.34, 0.09], OUT: [0.46, 0.06], GND: [0.59, 0.04], VCC: [0.72, 0.03] },
  },
  cp2102: {
    texture: '/example/cp2102.jpg',
    at: { '+5V': [0.03, 0.17], GND: [0.03, 0.37], RXD: [0.03, 0.56], TXD: [0.03, 0.74], '3V3': [0.03, 0.93] },
  },
};

const from = (alias: string, id: string, name?: string): Part => {
  const known = library.find((k) => k.aliases.includes(alias))!;
  const part = { ...structuredClone(known.part), id, name: name ?? known.part.name };
  const photo = photos[alias];
  if (photo) {
    part.texture = photo.texture;
    for (const pin of part.pins) {
      const at = photo.at[pin.id];
      if (at) pin.at = { u: at[0], v: at[1] };
    }
  }
  return part;
};

export const example: Guide = {
  title: 'Radar sensors to a Mac',
  summary: 'An LD2450 tracking radar and an LD2410C presence radar, each wired to its own CP2102 USB adapter.',
  parts: [
    from('ld2450', 'ld2450'),
    from('cp2102', 'usb1', 'USB adapter 1'),
    from('ld2410c', 'ld2410c'),
    from('cp2102', 'usb2', 'USB adapter 2'),
  ],
  steps: [
    {
      title: 'Plug the cable into the LD2450',
      instruction:
        'Turn the LD2450 so the side with tiny printed labels faces you. Push the white plug of the 4-wire cable into the white socket. It only fits one way.',
      show: ['ld2450'],
      connections: [],
      focus: ['ld2450.5V', 'ld2450.RX', 'ld2450.TX', 'ld2450.GND'],
      caution: 'On this cable black is 5V power and yellow is ground, the opposite of the usual colours.',
      check: 'Read which colour lands next to 5V, RX, TX and GND.',
    },
    {
      title: 'Power and ground to adapter 1',
      instruction: 'Push the black wire onto +5V and the yellow wire onto GND of the first USB adapter.',
      show: ['ld2450', 'usb1'],
      connections: [
        { from: { part: 'ld2450', pin: '5V' }, to: { part: 'usb1', pin: '+5V' }, wire: 'black', note: '' },
        { from: { part: 'ld2450', pin: 'GND' }, to: { part: 'usb1', pin: 'GND' }, wire: 'yellow', note: '' },
      ],
      focus: ['usb1.+5V', 'usb1.GND'],
      caution: 'Never use the 3V3 pin.',
      check: '',
    },
    {
      title: 'Data wires cross over',
      instruction: 'White goes from TX to RXD, red goes from RX to TXD. What one side sends, the other receives.',
      show: ['ld2450', 'usb1'],
      connections: [
        { from: { part: 'ld2450', pin: 'TX' }, to: { part: 'usb1', pin: 'RXD' }, wire: 'white', note: '' },
        { from: { part: 'ld2450', pin: 'RX' }, to: { part: 'usb1', pin: 'TXD' }, wire: 'red', note: '' },
      ],
      focus: ['usb1.RXD', 'usb1.TXD'],
      caution: '',
      check: 'Take a photo of both ends before plugging the adapter in.',
    },
    {
      title: 'Wire the LD2410C to adapter 2',
      instruction:
        'Use four loose jumper wires. VCC to +5V, GND to GND, and again cross the data: TX to RXD, RX to TXD. Leave OUT empty.',
      show: ['ld2450', 'usb1', 'ld2410c', 'usb2'],
      connections: [
        { from: { part: 'ld2410c', pin: 'VCC' }, to: { part: 'usb2', pin: '+5V' }, wire: 'blue', note: '' },
        { from: { part: 'ld2410c', pin: 'GND' }, to: { part: 'usb2', pin: 'GND' }, wire: 'green', note: '' },
        { from: { part: 'ld2410c', pin: 'TX' }, to: { part: 'usb2', pin: 'RXD' }, wire: 'yellow', note: '' },
        { from: { part: 'ld2410c', pin: 'RX' }, to: { part: 'usb2', pin: 'TXD' }, wire: 'orange', note: '' },
      ],
      focus: ['ld2410c', 'usb2'],
      caution: 'OUT and 3V3 stay empty.',
      check: 'Photo again before plugging in.',
    },
    {
      title: 'Plug both adapters into the computer',
      instruction: 'Plug each USB adapter in (through a USB-C adapter on a Mac). A small light on each adapter turns on.',
      show: ['ld2450', 'usb1', 'ld2410c', 'usb2'],
      connections: [],
      focus: ['usb1', 'usb2'],
      caution: '',
      check: 'Both adapters should show up as serial ports.',
    },
  ],
};
