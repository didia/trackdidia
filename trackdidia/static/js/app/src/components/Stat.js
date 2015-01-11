 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/WeekStat", "app/event","app/constants", "app/trackdidia", "bootstrap"], function(React, WeekStatComponent, EventProvider, Constants, trackdidia){
	var StatComponent = React.createClass({
	    
	    getInitialState: function() {
	    	return trackdidia.getStats();
	    },
		componentDidMount: function() {
			EventProvider.subscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},

		componentWillUnmount: function() {
			EventProvider.unsubscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},
		_onChange: function() {
			this.setState(trackdidia.getStats());
		},
		_getAllWidgets : function() {
			var widgets = [];

			var widgetExecution = this._getExecutionWidgets();
			for(var i = 0; i < widgetExecution.length; i++) {
				widgets.push(widgetExecution[i]);
			}

			var widgetStress = this._getStressWidgets();
			for(var i = 0; i < widgetStress.length ; i++) {
				widgets.push(widgetStress[i]);
			}


			return widgets;
		},
		_getStressWidgets : function() {
			var widgets = [];
			var stats = this.state;
			var current_week = stats != null?stats['stress']['current-week']:{};
			var last_week = stats != null?stats['stress']['last-week']:{};
			if (current_week != null) {
				current_week["title"] = "Current week stress";
				widgets.push(<WeekStatComponent enable_color = {false} key = {current_week.title} data = {current_week} />);
			}
			if (last_week != null) {
				last_week["title"] = "Last week stress";
				widgets.push(<WeekStatComponent  enable_color = {false} key = {last_week.title} data = {last_week} />);
			}

			return widgets;
		},
		_getExecutionWidgets : function() {
			var widgets = [];
			var stats = this.state;
			var current_week = stats != null?stats['execution']['current-week']:{};
			var last_week = stats != null?stats['execution']['last-week']:{};
			if (current_week != null) {
				current_week["title"] = "Current week execution";
				widgets.push(<WeekStatComponent enable_color = {true} key = {current_week.title} data = {current_week} />);
			}
			if (last_week != null) {
				last_week["title"] = "Last week execution";
				widgets.push(<WeekStatComponent enable_color = {true} key = {last_week.title} data = {last_week} />);
			}

			return widgets;
		},
		render: function() {
			var widgets = this._getAllWidgets();
			var body = [];

			for(var i = 0; i <widgets.length; i++) {
				body.push(<div key = {i} className = "col-md-4"> {widgets[i]} </div>);
			}

			return (
				<div className = "stat-page text-center">
					{body}
				</div>
			);
		}
	});

	return StatComponent;
})