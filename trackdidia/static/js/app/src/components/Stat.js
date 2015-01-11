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
			var stats = this.state;
			var current_week = stats != null?stats['current-week']:{};
			var last_week = stats != null?stats['last-week']:{};
			if (current_week != null) {
				current_week["title"] = "Current week";
				widgets.push(<WeekStatComponent key = {current_week.title} data = {current_week} />);
			}
			if (last_week != null) {
				last_week["title"] = "Current week";
				widgets.push(<WeekStatComponent key = {last_week.title} data = {last_week} />);
			}

			return widgets;
		},

		render: function() {
			var widgets = this._getAllWidgets();
			var body = [];
			
			for(var i = 0; i <widgets.length; i++) {
				body.push(<div key = {i} className = "col-sm-4"> {widgets[i]} </div>);
			}

			return (
				<div className = "row">
					{body}
				</div>
			);
		}
	});

	return StatComponent;
})