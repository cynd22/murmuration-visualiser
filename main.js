// Electron main process for the Murmuration visualiser.
//
// Creates the window and wires up Windows system-audio loopback capture: when
// the renderer calls navigator.mediaDevices.getDisplayMedia(), this handler
// satisfies it with the system audio output ('loopback') instead of popping a
// picker. The renderer keeps only the audio track and feeds it to the in-app
// audio engine (audio-engine.js).

const { app, BrowserWindow, session, desktopCapturer } = require( 'electron' );
const path = require( 'node:path' );

// Audio analysis runs continuously without a user gesture; allow it.
app.commandLine.appendSwitch( 'autoplay-policy', 'no-user-gesture-required' );

function createWindow() {

	const win = new BrowserWindow( {
		width: 1280,
		height: 720,
		backgroundColor: '#000000',
		title: 'Murmuration',
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	} );

	win.removeMenu();

	// F11 toggles fullscreen; Esc leaves fullscreen. (Window close quits.)
	win.webContents.on( 'before-input-event', ( event, input ) => {

		if ( input.type !== 'keyDown' ) return;
		if ( input.key === 'F11' ) {

			win.setFullScreen( ! win.isFullScreen() );
			event.preventDefault();

		} else if ( input.key === 'Escape' && win.isFullScreen() ) {

			win.setFullScreen( false );
			event.preventDefault();

		}

	} );

	win.loadFile( path.join( __dirname, 'renderer', 'index.html' ) );

}

app.whenReady().then( () => {

	// Grant system-audio loopback to getDisplayMedia without a picker.
	session.defaultSession.setDisplayMediaRequestHandler( ( request, callback ) => {

		desktopCapturer.getSources( { types: [ 'screen' ] } ).then( ( sources ) => {

			// A video source is required by getDisplayMedia; the renderer discards
			// the video track and keeps only 'loopback' system audio.
			if ( sources.length > 0 ) {

				callback( { video: sources[ 0 ], audio: 'loopback' } );

			} else {

				callback( { audio: 'loopback' } );

			}

		} ).catch( () => callback( { audio: 'loopback' } ) );

	}, { useSystemPicker: false } );

	createWindow();

	app.on( 'activate', () => {

		if ( BrowserWindow.getAllWindows().length === 0 ) createWindow();

	} );

} );

app.on( 'window-all-closed', () => {

	if ( process.platform !== 'darwin' ) app.quit();

} );
