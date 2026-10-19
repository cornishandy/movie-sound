-- Movie Sound: double-click to switch Andy's movie sound settings (the Chrome DSP bridge) on or off.
-- On: runs `movie-audio on` (bridge server, bridge page in Chrome, Mac sound to BlackHole), presses the page's
-- Start button for you, then puts Chrome away so you're back in the browser you were using. Pressing Start needs Movie Sound allowed under
-- System Settings > Privacy & Security > Accessibility; without that it asks you to click Start yourself.
-- Off: runs `movie-audio off` (Mac sound straight to the iFi, bridge page closed, server stopped).
-- Built with build.sh from this file; the icon comes from icon.swift.
property cmd : "$HOME/.local/bin/movie-audio"

on run
	if (do shell script cmd & " is-on") is "yes" then
		do shell script cmd & " off"
		display notification "Sound goes straight to your iFi." with title "Movie sound OFF"
		return
	end if
	try
		set r to do shell script cmd & " on 2>&1"
	on error errText
		display dialog "Couldn't turn movie sound on." & return & return & errText buttons {"OK"} default button 1 with title "Movie Sound" with icon caution
		return
	end try
	if r contains "already running" then
		display notification "Your movie sound settings are on." with title "Movie sound ON"
		return
	end if
	if my pressStart() then
		log "started; minimizing Chrome"
		try
			tell application "Google Chrome" to set minimized of front window to true
			-- Hiding Chrome hands the screen back to the app you were in (Safari, Orion...), once the
			-- minimize animation has finished.
			delay 0.8
			tell application "System Events" to set visible of process "Google Chrome" to false
		on error e
			log "minimize failed: " & e
		end try
		display notification "Your movie sound settings are on." with title "Movie sound ON"
	else
		display notification "Click Start on the Movie DSP bridge page in Chrome." with title "Movie sound: one click needed"
	end if
end run

-- Title of the tab Chrome is showing, and whether it is still loading.
on activeTab()
	tell application "Google Chrome"
		set t to active tab of front window
		return {title of t, loading of t}
	end tell
end activeTab

-- Waits for the bridge page, then presses Return, which clicks its focused Start button. True once it runs.
on pressStart()
	try
		repeat 30 times
			set {theTitle, isLoading} to my activeTab()
			if theTitle contains "Movie DSP bridge" and not isLoading then exit repeat
			delay 0.5
		end repeat
		log "page ready: " & theTitle
		if theTitle does not contain "Movie DSP bridge" then return false
		delay 0.5
		tell application "Google Chrome" to activate
		delay 0.5
		tell application "System Events"
			set f to name of first process whose frontmost is true
			log "frontmost before Return: " & f
			if f is not "Google Chrome" then return false
			key code 36
		end tell
		repeat 16 times
			delay 0.5
			if item 1 of my activeTab() contains "▶" then return true
		end repeat
	on error e
		log "pressStart error: " & e
	end try
	return false
end pressStart
