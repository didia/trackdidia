 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Day", "bootstrap"], function(React, DayComponent){

	var ReactPropTypes = React.PropTypes;

	var ScheduleComponent = React.createClass({
		
		propTypes : {
			schedule : ReactPropTypes.object.isRequired
	    },
	    
	    getInitialState: function() {
	    	return null;
	    },
		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {
			var schedule = this.props.schedule;
			var allDays = this.props.schedule.days;
			var days = [];
			
			for (var i = 1; i<8; i++) {
				days.push(<DayComponent key={i} day={allDays[i]} />);
			}

			return (
				<div>

					<header>
					   <span>Schedule from {schedule.starting_date} to {schedule.ending_date} </span>
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