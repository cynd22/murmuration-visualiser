// In-app audio analysis engine.
//
// A faithful 1:1 JS port of share/feeder.py (Analyser + OnsetDetector). The
// Python feeder captured PipeWire audio, ran this DSP, and streamed the result
// over a websocket; here the same maths runs in-process on Windows loopback
// audio. The emitted object has the EXACT shape feeder.py sent over the socket:
//   { t, amp, bands{7}, onsets{7}, onset_envelopes{7} }
// so the visualiser's existing audioState wiring is reused unchanged.
//
// The DSP (rfftMagnitude / Analyser / OnsetDetector) is pure and free of any
// browser globals, so it can be imported under Node for parity testing against
// the real feeder.py. The AudioEngine class at the bottom is the browser-only
// glue (AudioContext + worklet) and only touches Web Audio when constructed.

export const SAMPLE_RATE = 44100;
export const BLOCK_SIZE = 1024;

// (name, loHz, hiHz) — identical to feeder.py BANDS.
export const BANDS = [
	[ 'subBass', 20, 60 ],
	[ 'bass', 60, 250 ],
	[ 'lowMid', 250, 500 ],
	[ 'mid', 500, 2000 ],
	[ 'upperMid', 2000, 4000 ],
	[ 'treble', 4000, 8000 ],
	[ 'air', 8000, 20000 ],
];
export const BAND_NAMES = BANDS.map( b => b[ 0 ] );

const AGC_DECAY = 0.9995;
const AGC_FLOOR = 1e-4;

// Onset knobs (feeder.py:40-46).
const ONSET_HISTORY_SECONDS = 1.0;
const ONSET_ENVELOPE_DECAY = 0.88;
const ONSET_THRESHOLD_MULT = 3.5;
const ONSET_REFRACTORY_SECONDS = 0.15;
const ONSET_FLUX_FLOOR = 0.002;

// ---- FFT -------------------------------------------------------------------
// Iterative in-place radix-2 Cooley-Tukey, forward transform with the
// exp(-2πi·kn/N) sign convention and NO normalisation — matching numpy's
// np.fft.rfft. Returns the first N/2+1 magnitudes (513 for N=1024), i.e. the
// real-FFT magnitude spectrum np.abs(np.fft.rfft(x)).
export function rfftMagnitude( signal ) {

	const n = signal.length;
	const re = new Float64Array( n );
	const im = new Float64Array( n );
	for ( let i = 0; i < n; i ++ ) re[ i ] = signal[ i ];

	// Bit-reversal permutation.
	for ( let i = 1, j = 0; i < n; i ++ ) {

		let bit = n >> 1;
		for ( ; j & bit; bit >>= 1 ) j ^= bit;
		j ^= bit;
		if ( i < j ) {

			const tr = re[ i ]; re[ i ] = re[ j ]; re[ j ] = tr;
			const ti = im[ i ]; im[ i ] = im[ j ]; im[ j ] = ti;

		}

	}

	for ( let len = 2; len <= n; len <<= 1 ) {

		const ang = -2 * Math.PI / len;
		const wr = Math.cos( ang );
		const wi = Math.sin( ang );
		const half = len >> 1;
		for ( let i = 0; i < n; i += len ) {

			let cr = 1, ci = 0;
			for ( let k = 0; k < half; k ++ ) {

				const ur = re[ i + k ], ui = im[ i + k ];
				const er = re[ i + k + half ], ei = im[ i + k + half ];
				const vr = er * cr - ei * ci;
				const vi = er * ci + ei * cr;
				re[ i + k ] = ur + vr; im[ i + k ] = ui + vi;
				re[ i + k + half ] = ur - vr; im[ i + k + half ] = ui - vi;
				const ncr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = ncr;

			}

		}

	}

	const half = ( n >> 1 ) + 1;
	const mag = new Float64Array( half );
	for ( let k = 0; k < half; k ++ ) mag[ k ] = Math.hypot( re[ k ], im[ k ] );
	return mag;

}

function hanning( m ) {

	const w = new Float64Array( m );
	if ( m === 1 ) { w[ 0 ] = 1; return w; }
	for ( let n = 0; n < m; n ++ ) w[ n ] = 0.5 - 0.5 * Math.cos( ( 2 * Math.PI * n ) / ( m - 1 ) );
	return w;

}

// ---- Analyser (port of feeder.py:106-149) ---------------------------------
export class Analyser {

	constructor( sampleRate = SAMPLE_RATE, blockSize = BLOCK_SIZE ) {

		this.sampleRate = sampleRate;
		this.blockSize = blockSize;
		this.window = hanning( blockSize );

		// rfftfreq(blockSize, 1/sr)[k] = k * sr / blockSize, k = 0..blockSize/2.
		const nBins = ( blockSize >> 1 ) + 1;
		const freqs = new Float64Array( nBins );
		for ( let k = 0; k < nBins; k ++ ) freqs[ k ] = ( k * sampleRate ) / blockSize;

		// band_slices: [start, stop) over bins where lo <= f < hi.
		this.bandSlices = BANDS.map( ( [ name, lo, hi ] ) => {

			let first = - 1, last = - 1;
			for ( let k = 0; k < nBins; k ++ ) {

				if ( freqs[ k ] >= lo && freqs[ k ] < hi ) {

					if ( first < 0 ) first = k;
					last = k;

				}

			}

			return first < 0 ? [ name, 0, 0 ] : [ name, first, last + 1 ];

		} );

		this.agcMax = Object.fromEntries( BAND_NAMES.map( n => [ n, AGC_FLOOR ] ) );
		this.ampAgcMax = AGC_FLOOR;

	}

	// block: Float32Array/Float64Array of length blockSize (mono).
	process( block ) {

		let sumSq = 0;
		for ( let i = 0; i < block.length; i ++ ) sumSq += block[ i ] * block[ i ];
		const rms = Math.sqrt( sumSq / block.length );
		this.ampAgcMax = Math.max( rms, this.ampAgcMax * AGC_DECAY );
		const ampNorm = Math.min( 1.0, rms / Math.max( this.ampAgcMax, AGC_FLOOR ) );

		const windowed = new Float64Array( block.length );
		for ( let i = 0; i < block.length; i ++ ) windowed[ i ] = block[ i ] * this.window[ i ];
		const spec = rfftMagnitude( windowed );

		const bandsNorm = {};
		const bandsRaw = {};
		for ( const [ name, start, stop ] of this.bandSlices ) {

			let val = 0;
			if ( stop > start ) {

				let s = 0;
				for ( let k = start; k < stop; k ++ ) s += spec[ k ];
				val = s / ( stop - start );

			}

			bandsRaw[ name ] = val;
			this.agcMax[ name ] = Math.max( val, this.agcMax[ name ] * AGC_DECAY );
			bandsNorm[ name ] = Math.min( 1.0, val / Math.max( this.agcMax[ name ], AGC_FLOOR ) );

		}

		// rawAmp is the pre-AGC RMS. The normalised amp/bands can't tell a dead
		// loopback (silent / wrong device) from genuinely quiet music — AGC lifts
		// both toward similar values — but the raw RMS can: a dead loopback is
		// ~0, while even quiet music sits well above pure silence. The UI uses
		// this to drive a distinct "no signal" status instead of a false green.
		return { amp: ampNorm, bands: bandsNorm, rawBands: bandsRaw, rawAmp: rms };

	}

}

// ---- Onset detector (port of feeder.py:152-198) ---------------------------
export class OnsetDetector {

	constructor( bandNames = BAND_NAMES, sampleRate = 43.0 ) {

		this.bandNames = bandNames.slice();
		this.historySize = Math.max( 10, Math.trunc( ONSET_HISTORY_SECONDS * sampleRate ) );
		this.fluxHistory = Object.fromEntries( this.bandNames.map( n => [ n, [] ] ) );
		this.prevRaw = Object.fromEntries( this.bandNames.map( n => [ n, 0.0 ] ) );
		this.envelopes = Object.fromEntries( this.bandNames.map( n => [ n, 0.0 ] ) );
		this.lastOnsetT = Object.fromEntries( this.bandNames.map( n => [ n, - 1.0 ] ) );
		this.onsetCount = Object.fromEntries( this.bandNames.map( n => [ n, 0 ] ) );

	}

	process( rawBands, t ) {

		const onsets = {};
		for ( const name of this.bandNames ) {

			const current = rawBands[ name ] ?? 0.0;
			const prev = this.prevRaw[ name ];

			const flux = Math.max( 0.0, current - prev );
			const hist = this.fluxHistory[ name ];
			hist.push( flux );
			if ( hist.length > this.historySize ) hist.shift();

			let fired = false;
			if ( hist.length >= 10 && flux > ONSET_FLUX_FLOOR ) {

				let sum = 0;
				for ( let i = 0; i < hist.length; i ++ ) sum += hist[ i ];
				const mean = sum / hist.length;
				const threshold = Math.max( ONSET_FLUX_FLOOR, mean * ONSET_THRESHOLD_MULT );

				if ( flux > threshold && t - this.lastOnsetT[ name ] > ONSET_REFRACTORY_SECONDS ) {

					fired = true;
					const relative = flux / ( mean * 4.0 + 1e-6 );
					this.envelopes[ name ] = Math.max( this.envelopes[ name ], Math.min( 1.0, relative ) );
					this.lastOnsetT[ name ] = t;
					this.onsetCount[ name ] += 1;

				}

			}

			onsets[ name ] = fired;
			this.envelopes[ name ] *= ONSET_ENVELOPE_DECAY;
			this.prevRaw[ name ] = current;

		}

		return { onsets, envelopes: { ...this.envelopes } };

	}

}

// Convenience: run one 1024-sample block through both stages and return the
// feeder.py websocket message shape.
export function makePipeline() {

	const analyser = new Analyser();
	const detector = new OnsetDetector();
	let blockIndex = 0;

	return function processBlock( block ) {

		// Audio-timeline clock (deterministic; equals feeder's time.time() role
		// for the refractory/threshold logic). Each block advances by one frame.
		const t = ( blockIndex * BLOCK_SIZE ) / SAMPLE_RATE;
		blockIndex += 1;

		const { amp, bands, rawBands, rawAmp } = analyser.process( block );
		const { onsets, envelopes } = detector.process( rawBands, t );
		return { t, amp, bands, onsets, onset_envelopes: envelopes, rawAmp };

	};

}

// ---- Browser glue: capture loopback audio and run the pipeline -------------
// Not used under Node. Builds an AudioContext locked to 44100 Hz, routes the
// loopback MediaStream through capture-worklet.js (which emits 1024-sample mono
// blocks), and invokes onFrame(message) for each analysed block.
export class AudioEngine {

	constructor( { onFrame, workletUrl } ) {

		this.onFrame = onFrame;
		this.workletUrl = workletUrl;
		this.ctx = null;
		this.node = null;
		this.source = null;
		this.process = makePipeline();

	}

	async start( stream ) {

		// Lock the context to 44100 Hz so band bins / block timing match feeder.py.
		this.ctx = new ( window.AudioContext || window.webkitAudioContext )( { sampleRate: SAMPLE_RATE } );
		await this.ctx.audioWorklet.addModule( this.workletUrl );

		this.source = this.ctx.createMediaStreamSource( stream );
		this.node = new AudioWorkletNode( this.ctx, 'block-capture', {
			numberOfInputs: 1,
			numberOfOutputs: 0,
			channelCount: 2,
			channelCountMode: 'explicit',
			processorOptions: { blockSize: BLOCK_SIZE },
		} );

		this.node.port.onmessage = ( ev ) => {

			const block = ev.data; // Float32Array, length BLOCK_SIZE, mono
			const msg = this.process( block );
			if ( this.onFrame ) this.onFrame( msg );

		};

		this.source.connect( this.node );
		if ( this.ctx.state === 'suspended' ) await this.ctx.resume();

	}

	async stop() {

		try { if ( this.source ) this.source.disconnect(); } catch ( e ) {}
		try { if ( this.node ) this.node.disconnect(); } catch ( e ) {}
		if ( this.ctx ) await this.ctx.close();
		this.ctx = this.node = this.source = null;

	}

}
