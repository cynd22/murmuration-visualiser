// AudioWorklet processor: downmix incoming loopback audio to mono and emit
// fixed 1024-sample blocks (BLOCK_SIZE) to the main thread, matching the block
// size feeder.py read from the audio device. The browser delivers audio in
// 128-sample render quanta, so we accumulate into a 1024 ring buffer and post a
// copy each time it fills.

class BlockCapture extends AudioWorkletProcessor {

	constructor( options ) {

		super();
		this.blockSize = ( options.processorOptions && options.processorOptions.blockSize ) || 1024;
		this.buffer = new Float32Array( this.blockSize );
		this.fill = 0;

	}

	process( inputs ) {

		const input = inputs[ 0 ];
		if ( ! input || input.length === 0 ) return true; // no signal this quantum

		const ch0 = input[ 0 ];
		const ch1 = input.length > 1 ? input[ 1 ] : null;
		if ( ! ch0 ) return true;

		const frames = ch0.length; // normally 128
		for ( let i = 0; i < frames; i ++ ) {

			// Mono downmix: mean of available channels (feeder did indata.mean(axis=1)).
			const sample = ch1 ? ( ch0[ i ] + ch1[ i ] ) * 0.5 : ch0[ i ];
			this.buffer[ this.fill ++ ] = sample;

			if ( this.fill === this.blockSize ) {

				// Post a copy; the buffer is reused for the next block.
				this.port.postMessage( this.buffer.slice( 0 ) );
				this.fill = 0;

			}

		}

		return true; // keep processor alive

	}

}

registerProcessor( 'block-capture', BlockCapture );
