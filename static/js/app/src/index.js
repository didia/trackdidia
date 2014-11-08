/** @jsx React.DOM */

"use strict";

define(["react", "./trackdidia", "components/Schedule", "app/event", "app/constants"], function(React,trackdidia, ScheduleComponent, EventProvider, Constants){
	
	function render() {
		var schedule = trackdidia.getSchedule();

		React.render(
  			<ScheduleComponent schedule= {schedule} />,
  			document.getElementById('app')
		);

		EventProvider.clear(Constants.SCHEDULE_LOADED_EVENT);
	}

	EventProvider.subscribe(Constants.SCHEDULE_LOADED_EVENT, render);
	trackdidia.initialize();
	
	
	
})
