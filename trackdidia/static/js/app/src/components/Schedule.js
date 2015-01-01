 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Day", "app/event","app/constants", "app/trackdidia", "bootstrap"], function(React, DayComponent, EventProvider, Constants, trackdidia){
	var ScheduleComponent = React.createClass({
	    
	    getInitialState: function() {
	    	return trackdidia.getSchedule();
	    },
		componentDidMount: function() {
			EventProvider.subscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},

		componentWillUnmount: function() {
			EventProvider.unsubscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},
		_onChange: function() {
			this.setState(trackdidia.getSchedule());
		},
		render: function() {
			var schedule = this.state;
			var allDays = schedule.days;
			var days = [];
			
			for (var i = 1; i<8; i++) {
				days.push(<DayComponent key={i} day={allDays[i]} />);
			}

			return (
				<div>

					<header className = "text-center bg-primary">
					   <span>Schedule from <b>{schedule.starting_date}</b> to <b>{schedule.ending_date}</b> </span>
					</header>

					<div id = "schedule" className = "panel-group" role = "tablist" aria-multiselectable = "true">
						{days}
					</div>

				</div>
			);
		}
	});

	return ScheduleComponent;
})