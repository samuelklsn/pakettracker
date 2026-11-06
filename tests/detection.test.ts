import { describe, expect, it } from 'vitest';
import { detect, s10Checksum, upsChecksum } from '../src/services/detection.service';

describe('Smart-Input detection', () => {
  it('detects empty input', () => {
    expect(detect('   ').kind).toBe('empty');
  });

  it('detects e-mail addresses', () => {
    const r = detect('Max.Mustermann@Example.de');
    expect(r.kind).toBe('email');
    expect(r.email).toBe('max.mustermann@example.de');
  });

  it('detects UPS 1Z numbers incl. checksum', () => {
    expect(upsChecksum('1Z999AA10123456784')).toBe(true);
    const r = detect('1z 999 aa1 0123 4567 84');
    expect(r.kind).toBe('tracking');
    expect(r.trackingNumber).toBe('1Z999AA10123456784');
    expect(r.candidates[0]?.carrier).toBe('ups');
    expect(r.candidates[0]?.reason).toContain('Prüfziffer gültig');
  });

  it('detects DHL formats', () => {
    expect(detect('00340434161234567890').candidates[0]?.carrier).toBe('dhl');
    expect(detect('JJD000390007843123456').candidates[0]?.carrier).toBe('dhl');
    expect(detect('123456789012').candidates[0]?.carrier).toBe('dhl');
  });

  it('validates UPU S10 numbers (Deutsche Post / DHL international)', () => {
    expect(s10Checksum('RR473124829DE')).toBe(true);
    expect(detect('RR473124829DE').candidates[0]?.carrier).toBe('dhl');
  });

  it('detects Hermes H-numbers', () => {
    expect(detect('H1002290001234567890').candidates[0]?.carrier).toBe('hermes');
  });

  it('returns ranked candidates for ambiguous 14-digit numbers (DPD / Hermes)', () => {
    const r = detect('01234567890123');
    const carriers = r.candidates.map((c) => c.carrier);
    expect(carriers[0]).toBe('dpd');
    expect(carriers).toContain('hermes');
  });

  it('extracts carrier and number from tracking URLs', () => {
    const dpd = detect('https://tracking.dpd.de/status/de_DE/parcel/01234567890123');
    expect(dpd.kind).toBe('url');
    expect(dpd.trackingNumber).toBe('01234567890123');
    expect(dpd.candidates[0]?.carrier).toBe('dpd');

    const dhl = detect('https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161234567890');
    expect(dhl.trackingNumber).toBe('00340434161234567890');
    expect(dhl.candidates[0]?.carrier).toBe('dhl');

    const ups = detect('www.ups.com/track?loc=de_DE&tracknum=1Z999AA10123456784');
    expect(ups.candidates[0]?.carrier).toBe('ups');
    expect(ups.trackingNumber).toBe('1Z999AA10123456784');
  });

  it('does not treat lookalike hosts as carriers', () => {
    const r = detect('https://dhl.de.evil.example/track?piececode=00340434161234567890');
    expect(r.candidates[0]?.reason).not.toContain('Link von');
  });

  it('falls back to unknown for free text', () => {
    expect(detect('Kopfhörer').kind).toBe('unknown');
  });
});
