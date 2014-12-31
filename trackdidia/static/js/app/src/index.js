/** @jsx React.DOM */

"use strict";

define(["react", "./trackdidia", "components/Application", "app/event", "app/constants"], function(React,trackdidia, ApplicationComponent, EventProvider, Constants){
	
	function render() {

		

		React.render(
  			<ApplicationComponent />,
  			document.body
		);


		EventProvider.clear(Constants.SCHEDULE_LOADED_EVENT);
	}

	EventProvider.subscribe(Constants.SCHEDULE_LOADED_EVENT, render);

	trackdidia.initialize();
	
	
	
})
