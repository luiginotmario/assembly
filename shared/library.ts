import type { Part } from './types';

// Parts we know exactly: sizes from the datasheets, pin order checked against real boards.
// The guide agent copies these instead of guessing whenever a plan mentions one.

type Known = { aliases: string[]; part: Omit<Part, 'id'> };

export const library: Known[] = [
  {
    aliases: ['ld2450', 'hlk-ld2450'],
    part: {
      name: 'LD2450 radar',
      model: 'HLK-LD2450',
      kind: 'sensor',
      size: { w: 44, h: 15, t: 1 },
      color: '#1f5fbf',
      pitch: 1.25,
      // seen from the back, where the labels are; the gold antennas face down
      pins: [
        { id: '5V', label: '5V', side: 'left', index: 0, style: 'socket' },
        { id: 'RX', label: 'RX', side: 'left', index: 1, style: 'socket' },
        { id: 'TX', label: 'TX', side: 'left', index: 2, style: 'socket' },
        { id: 'GND', label: 'GND', side: 'left', index: 3, style: 'socket' },
      ],
      features: [
        { kind: 'socket', side: 'left', at: 0.5, label: '4-pin socket' },
        { kind: 'chip', side: 'top', at: 0.35, label: '' },
      ],
      estimated: false,
      source: 'library',
      note: 'Labels are on the back. Some cables are coloured unusually: check which colour lands on 5V.',
    },
  },
  {
    aliases: ['ld2410c', 'ld2410', 'hlk-ld2410c'],
    part: {
      name: 'LD2410C presence radar',
      model: 'HLK-LD2410C',
      kind: 'sensor',
      size: { w: 22, h: 16, t: 1 },
      color: '#1f5fbf',
      pitch: 2.54,
      pins: [
        { id: 'TX', label: 'TX', side: 'top', index: 0, style: 'header' },
        { id: 'RX', label: 'RX', side: 'top', index: 1, style: 'header' },
        { id: 'OUT', label: 'OUT', side: 'top', index: 2, style: 'header' },
        { id: 'GND', label: 'GND', side: 'top', index: 3, style: 'header' },
        { id: 'VCC', label: 'VCC', side: 'top', index: 4, style: 'header' },
      ],
      features: [{ kind: 'antenna', side: 'bottom', at: 0.5, label: '' }],
      estimated: false,
      source: 'library',
      note: 'OUT is a simple yes/no presence pin; leave it unconnected when using the serial pins.',
    },
  },
  {
    aliases: ['cp2102', 'usb to ttl', 'usb-to-ttl', 'usb ttl', 'usb-ttl'],
    part: {
      name: 'CP2102 USB adapter',
      model: 'CP2102 USB to TTL',
      kind: 'adapter',
      size: { w: 52, h: 16, t: 1.6 },
      color: '#c8302a',
      pitch: 2.54,
      pins: [
        { id: '+5V', label: '+5V', side: 'left', index: 0, style: 'header' },
        { id: 'GND', label: 'GND', side: 'left', index: 1, style: 'header' },
        { id: 'RXD', label: 'RXD', side: 'left', index: 2, style: 'header' },
        { id: 'TXD', label: 'TXD', side: 'left', index: 3, style: 'header' },
        { id: '3V3', label: '3V3', side: 'left', index: 4, style: 'header' },
      ],
      features: [
        { kind: 'usb-a', side: 'right', at: 0.5, label: 'USB' },
        { kind: 'chip', side: 'top', at: 0.45, label: 'CP2102' },
      ],
      // size measured off a straightened photo of a real stick (52 x 16 mm including the plug)
      estimated: false,
      source: 'library',
      note: 'Pin order varies between makers of these sticks. Read the labels on yours.',
    },
  },
];
