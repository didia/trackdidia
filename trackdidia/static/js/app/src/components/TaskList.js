 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Task", "app/event","app/constants", "app/trackdidia", "bootstrap"], function(React, TaskComponent, EventProvider, Constants, trackdidia){
	
	var TaskListComponent = React.createClass({
	    
	    getInitialState: function() {
	    	return {
	    		'tasks': trackdidia.getAllTasks()
	    	}
	    },
		componentDidMount: function() {
			EventProvider.subscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},

		componentWillUnmount: function() {
			EventProvider.unsubscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},
		_onChange: function() {
			var state = this.state;
			state.tasks = trackdidia.getAllTasks();
			this.setState(state);
		},
		render: function() {
	
			var allTasks = this.state.tasks;

			var tasks = [];
			
			for (var key in allTasks) {
				tasks.push(<TaskComponent key={key} task={allTasks[key]} />);
			}

			return (
				<div>

					<header className = "text-center bg-primary">
					   <span> Task List</span>
					</header>

					<div id = "tasks">
						{tasks}
					</div>

				</div>
			);
		}
	});

	return TaskListComponent;
})