 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Schedule", "app/event","app/constants", "app/trackdidia", "bootstrap"], function(React, ScheduleComponent, EventProvider, Constants, trackdidia){
	var ApplicationComponent = React.createClass({
	    
	    getInitialState: function() {
	    	return {
	    		page: 'schedule'
	    	};
	    },
		componentDidMount: function() {
			location.href = "#today";
		},

		componentWillUnmount: function() {
			console.log("Application component will unmount");
		},
		
		render: function() {
			var user = trackdidia.getMe();
			return (
				<div>
					<nav className = "navbar navbar-default navbar-fixed-top" id = "header">
						<div className = "container-fluid center-block">
							<div className = "navbar-right collapse navbar-collapse">
								<ul className = "nav navbar-nav">
									<li> <a href="#"> Tasks </a> </li>
									<li> <a href="#"> { user } </a> </li>
								</ul>
							</div>
						</div>
					</nav>

					<ScheduleComponent />

				</div>
			);
		}
	});

	return ApplicationComponent;
})