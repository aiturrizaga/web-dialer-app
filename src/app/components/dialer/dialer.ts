import { Component, signal, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SipService, SipConfig } from '../../services/sip';

@Component({
  selector: 'app-dialer',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './dialer.html',
  styleUrls: ['./dialer.scss'],
})
export class Dialer {

  readonly sip = inject(SipService);

  // ── Local signals ─────────────────────────────────────────────────────
  readonly destination  = signal('');
  readonly isMuted      = signal(false);
  readonly isSpeaker    = signal(false);
  readonly showDialpad  = signal(false); // dialpad during active call
  readonly showSettings = signal(false);
  readonly errorMsg     = signal('');
  readonly pressedKey   = signal('');    // for key press animation

  readonly config = signal<SipConfig>({
    wsServer:    'wss://35.188.44.45.nip.io:8089/ws',
    domain:      '35.188.44.45.nip.io',
    username:    'webagent1',
    password:    'xK9#mP2$vL8@nQ5w',
    displayName: 'Web Agent',
  });

  // ── Dialpad layout ────────────────────────────────────────────────────
  readonly keys = [
    { digit: '1', sub: '' },
    { digit: '2', sub: 'ABC' },
    { digit: '3', sub: 'DEF' },
    { digit: '4', sub: 'GHI' },
    { digit: '5', sub: 'JKL' },
    { digit: '6', sub: 'MNO' },
    { digit: '7', sub: 'PQRS' },
    { digit: '8', sub: 'TUV' },
    { digit: '9', sub: 'WXYZ' },
    { digit: '*', sub: '' },
    { digit: '0', sub: '+' },
    { digit: '#', sub: '' },
  ];

  // ── Computed ──────────────────────────────────────────────────────────
  readonly statusDot = computed(() => {
    const map: Record<string, string> = {
      disconnected: 'dot-gray',
      connecting:   'dot-yellow',
      registered:   'dot-green',
      error:        'dot-red',
    };
    return map[this.sip.sipStatus()] ?? 'dot-gray';
  });

  readonly callerName = computed(() => {
    const dest = this.destination();
    if (!dest) return '';
    // Could be extended with a contacts lookup
    return dest;
  });

  // ── Actions ───────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    this.errorMsg.set('');
    this.showSettings.set(false);
    try {
      await this.sip.connect(this.config());
    } catch (e: any) {
      this.errorMsg.set(e?.message ?? 'Error al conectar');
    }
  }

  async disconnect(): Promise<void> {
    await this.sip.disconnect();
  }

  pressKey(digit: string): void {
    // Animate key press
    this.pressedKey.set(digit);
    setTimeout(() => this.pressedKey.set(''), 150);

    if (this.sip.callStatus() === 'active') {
      this.sip.sendDTMF(digit);
    } else {
      this.destination.update(d => d + digit);
    }
  }

  backspace(): void {
    this.destination.update(d => d.slice(0, -1));
  }

  clearAll(): void {
    this.destination.set('');
  }

  async call(): Promise<void> {
    if (!this.destination().trim()) return;
    this.errorMsg.set('');
    try {
      await this.sip.call(this.destination().trim());
    } catch (e: any) {
      this.errorMsg.set(e?.message ?? 'Error al llamar');
    }
  }

  async hangup(): Promise<void> {
    this.showDialpad.set(false);
    await this.sip.hangup();
  }

  async acceptCall(): Promise<void> {
    await this.sip.acceptCall();
  }

  async rejectCall(): Promise<void> {
    await this.sip.rejectCall();
  }

  toggleMute(): void {
    const next = !this.isMuted();
    this.isMuted.set(next);
    this.sip.setMute(next);
  }

  toggleSpeaker(): void {
    this.isSpeaker.update(v => !v);
    // Browser doesn't expose speaker selection API widely yet,
    // but we track the state for UI feedback
  }

  toggleDialpad(): void {
    this.showDialpad.update(v => !v);
  }

  updateConfig(field: keyof SipConfig, value: string): void {
    this.config.update(c => ({ ...c, [field]: value }));
  }
}
