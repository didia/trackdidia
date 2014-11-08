/** @jsx React.DOM */

"use strict";

define(["react", "./trackdidia", "components/Schedule", "app/event", "app/constants"], function(React,trackdidia, ScheduleComponent, EventProvider, Constants){
	
	function render() {

		React.render(
  			<ScheduleComponent/>,
  			document.getElementById('app')
		);

		EventProvider.clear(Constants.SCHEDULE_LOADED_EVENT);
	}

	EventProvider.subscribe(Constants.SCHEDULE_LOADED_EVENT, render);
	trackdidia.initialize();
	
	
	
})
