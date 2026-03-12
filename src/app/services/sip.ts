import { Injectable, OnDestroy, signal, computed } from '@angular/core';
import {
  UserAgent,
  UserAgentOptions,
  Registerer,
  RegistererState,
  Inviter,
  Invitation,
  SessionState,
  Session,
  Web,
} from 'sip.js';

export type SipStatus = 'disconnected' | 'connecting' | 'registered' | 'error';
export type CallStatus = 'idle' | 'calling' | 'ringing' | 'active' | 'ending';

export interface SipConfig {
  wsServer: string;
  domain: string;
  username: string;
  password: string;
  displayName?: string;
}

@Injectable({ providedIn: 'root' })
export class SipService implements OnDestroy {

  // ── Signals (reactive state) ──────────────────────────────────────────
  readonly sipStatus   = signal<SipStatus>('disconnected');
  readonly callStatus  = signal<CallStatus>('idle');
  readonly callDuration = signal<number>(0);
  readonly incomingCall = signal<Invitation | null>(null);

  // ── Computed ──────────────────────────────────────────────────────────
  readonly isRegistered = computed(() => this.sipStatus() === 'registered');
  readonly isCalling    = computed(() => {
    const s = this.callStatus();
    return s !== 'idle' && s !== 'ending';
  });
  readonly formattedDuration = computed(() => {
    const d = this.callDuration();
    const m = Math.floor(d / 60).toString().padStart(2, '0');
    const s = (d % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  });
  readonly statusLabel = computed(() => {
    const map: Record<SipStatus, string> = {
      disconnected: 'Desconectado',
      connecting:   'Conectando...',
      registered:   'Registrado',
      error:        'Error',
    };
    return map[this.sipStatus()];
  });
  readonly callStatusLabel = computed(() => {
    const map: Record<CallStatus, string> = {
      idle:    '',
      calling: 'Llamando...',
      ringing: 'Llamada entrante',
      active:  'En llamada',
      ending:  'Finalizando...',
    };
    return map[this.callStatus()];
  });

  // ── Private internals ─────────────────────────────────────────────────
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private currentSession: Session | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private durationInterval: ReturnType<typeof setInterval> | null = null;
  private config: SipConfig | null = null;

  // ── Connect ───────────────────────────────────────────────────────────
  async connect(config: SipConfig): Promise<void> {
    this.config = config;
    this.sipStatus.set('connecting');

    const uri = UserAgent.makeURI(`sip:${config.username}@${config.domain}`);
    if (!uri) throw new Error('Invalid SIP URI');

    const options: UserAgentOptions = {
      uri,
      displayName: config.displayName ?? config.username,
      authorizationUsername: config.username,
      authorizationPassword: config.password,
      transportOptions: { server: config.wsServer } as Web.TransportOptions,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        },
      },
      delegate: {
        onDisconnect: (err?: Error) => {
          this.sipStatus.set(err ? 'error' : 'disconnected');
          this.callStatus.set('idle');
        },
        onInvite: (inv: Invitation) => {
          this.incomingCall.set(inv);
          this.callStatus.set('ringing');
        },
      },
    };

    this.ua = new UserAgent(options);

    // Listen BEFORE start() so we never miss a state transition
    this.registerer = new Registerer(this.ua);
    this.registerer.stateChange.addListener((state: RegistererState) => {
      if (state === RegistererState.Registered)   this.sipStatus.set('registered');
      if (state === RegistererState.Unregistered) this.sipStatus.set('disconnected');
    });

    await this.ua.start();
    await this.registerer.register();

    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
  }

  async disconnect(): Promise<void> {
    if (this.currentSession) await this.hangup();
    await this.registerer?.unregister();
    await this.ua?.stop();
    this.ua = null;
    this.registerer = null;
    this.sipStatus.set('disconnected');
  }

  // ── Outbound call ─────────────────────────────────────────────────────
  async call(destination: string): Promise<void> {
    if (!this.ua || !this.config) throw new Error('Not connected');

    const target = UserAgent.makeURI(`sip:${destination}@${this.config.domain}`);
    if (!target) throw new Error('Invalid destination');

    const inviter = new Inviter(this.ua, target, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
    });

    this.currentSession = inviter;
    this.callStatus.set('calling');
    this.attachSessionListeners(inviter);
    await inviter.invite();
  }

  // ── Incoming call ─────────────────────────────────────────────────────
  async acceptCall(): Promise<void> {
    const inv = this.incomingCall();
    if (!inv) return;
    this.currentSession = inv;
    this.attachSessionListeners(inv);
    await inv.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.incomingCall.set(null);
  }

  async rejectCall(): Promise<void> {
    await this.incomingCall()?.reject();
    this.incomingCall.set(null);
    this.callStatus.set('idle');
  }

  // ── Hangup ────────────────────────────────────────────────────────────
  async hangup(): Promise<void> {
    if (!this.currentSession) return;
    this.callStatus.set('ending');
    try {
      const state = this.currentSession.state;
      if (state === SessionState.Initial || state === SessionState.Establishing) {
        this.currentSession instanceof Inviter
          ? await this.currentSession.cancel()
          : await (this.currentSession as Invitation).reject();
      } else if (state === SessionState.Established) {
        await this.currentSession.bye();
      }
    } catch (e) { console.warn('Hangup error:', e); }
    this.currentSession = null;
    this.callStatus.set('idle');
    this.stopTimer();
  }

  // ── DTMF ──────────────────────────────────────────────────────────────
  sendDTMF(tone: string): void {
    if (this.currentSession?.state !== SessionState.Established) return;
    (this.currentSession.sessionDescriptionHandler as Web.SessionDescriptionHandler)?.sendDtmf(tone);
  }

  // ── Mute ──────────────────────────────────────────────────────────────
  setMute(muted: boolean): void {
    const pc = (this.currentSession?.sessionDescriptionHandler as any)
      ?.peerConnection as RTCPeerConnection | undefined;
    pc?.getSenders().forEach(sender => {
      if (sender.track?.kind === 'audio') sender.track.enabled = !muted;
    });
  }

  // ── Session listeners ─────────────────────────────────────────────────
  private attachSessionListeners(session: Session): void {
    session.stateChange.addListener((state: SessionState) => {
      switch (state) {
        case SessionState.Established:
          this.callStatus.set('active');
          this.startTimer();
          this.attachAudio(session);
          break;
        case SessionState.Terminated:
          this.callStatus.set('idle');
          this.stopTimer();
          this.cleanupAudio();
          this.currentSession = null;
          break;
      }
    });
  }

  private attachAudio(session: Session): void {
    const sdh = session.sessionDescriptionHandler as Web.SessionDescriptionHandler;
    if (!sdh) return;

    // Ensure audio element exists and is in the DOM
    if (!this.remoteAudio) {
      this.remoteAudio = document.createElement('audio');
      this.remoteAudio.autoplay = true;
      document.body.appendChild(this.remoteAudio);
    }

    const pc = sdh.peerConnection;
    if (!pc) return;

    const stream = new MediaStream();
    this.remoteAudio.srcObject = stream;

    // Add any tracks already present
    pc.getReceivers().forEach(receiver => {
      if (receiver.track) {
        stream.addTrack(receiver.track);
        console.log('[SIP] Added existing track:', receiver.track.kind, receiver.track.readyState);
      }
    });

    // Listen for new tracks arriving after establishment
    pc.ontrack = (event: RTCTrackEvent) => {
      console.log('[SIP] ontrack fired:', event.track.kind, event.streams.length);
      event.streams.forEach(s => {
        s.getTracks().forEach(track => {
          if (!stream.getTracks().includes(track)) {
            stream.addTrack(track);
            console.log('[SIP] Added new track from ontrack:', track.kind);
          }
        });
      });
      // Fallback: attach first stream directly
      if (event.streams[0] && this.remoteAudio) {
        this.remoteAudio.srcObject = event.streams[0];
      }
    };

    // Try to play (browsers may require user gesture)
    this.remoteAudio.play().catch(err => {
      console.warn('[SIP] Audio autoplay blocked, will play on next user gesture:', err);
    });
  }

  private startTimer(): void {
    this.callDuration.set(0);
    this.durationInterval = setInterval(
      () => this.callDuration.update(d => d + 1),
      1000
    );
  }

  private stopTimer(): void {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
    this.callDuration.set(0);
  }

  private cleanupAudio(): void {
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.pause();
      if (this.remoteAudio.parentNode) {
        this.remoteAudio.parentNode.removeChild(this.remoteAudio);
      }
      this.remoteAudio = null;
    }
  }

  ngOnDestroy(): void { this.disconnect(); }
}
