 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Schedule", "components/TaskList","components/Stat", "app/event","app/constants", "app/trackdidia", "bootstrap"], function(React, ScheduleComponent, TaskListComponent, StatComponent, EventProvider, Constants, trackdidia){
	var ApplicationComponent = React.createClass({
	    
	    getInitialState: function() {
	    	return {
	    		page: 'schedule'
	    	};
	    },
		componentDidMount: function() {
			var url = location.href;
			location.href = "#today";
			history.replaceState(null, null, url);
		},

		componentWillUnmount: function() {
			console.log("Application component will unmount");
		},

		getPageComponent : function() {
			if(this.state.page === "tasks") {
				console.log("Returning TaskListComponent");
				return <TaskListComponent />;
			}
			else if(this.state.page === "stats") {
				return <StatComponent />;
			}
			else{
				return <ScheduleComponent />;
			}
		},
		goToHomePage : function(e) {
			e.preventDefault();
			if(this.state.page !== "schedule") {
				this._setPage("schedule");
			}
		},
		goToTasksPage : function(e) {
			e.preventDefault();
			if (this.state.page !== "tasks"){
				this._setPage("tasks");
			}
			
		},
		goToStatsPage : function(e) {
			e.preventDefault();
			trackdidia.updateStats();
			if(this.state.page !== "stats"){
				this._setPage("stats");
			}
		},
		_setPage : function(page) {
			var state = this.state;
			state.page = page;
			this.setState(state);
		},
		isActive : function(page) {
			return this.state.page === page?"active":"";
		},
		
		render: function() {

			var user = trackdidia.getMe();
			var login = trackdidia.getLinkTo("untrial")

			return (
				<div>

					<nav className = "navbar navbar-default navbar-static-top" id = "header">
						<div className = "container">
							    <div className="navbar-header">
							      <button type="button" className="navbar-toggle collapsed" data-toggle="collapse" data-target="#navbar-collapse">
							        <span className="sr-only">Toggle navigation</span>
							        <span className="icon-bar"></span>
							        <span className="icon-bar"></span>
							        <span className="icon-bar"></span>
							      </button>
							    </div>
							<div className = "navbar-right collapse navbar-collapse" id="navbar-collapse">
								<ul className = "nav navbar-nav">
									<li className = {this.isActive("schedule")}> <a href = "" onClick={this.goToHomePage} onTouchEnd={this.goToHomePage}> Home </a> </li>
									<li className = {this.isActive("tasks")}> <a href="" onClick={this.goToTasksPage} onTouchEnd = {this.goToTasksPage}> Tasks </a> </li>
									<li className = {this.isActive("stats")}> <a href="" onClick={this.goToStatsPage} onTouchEnd = {this.goToTasksPage}> Stats </a> </li>
									<li> <a href="#"> { user } </a> </li>
								</ul>
							</div>
						</div>
					</nav>
					<div className="container">
						{user === "Guest"?
							<div className="alert-trial">
								You are using a trial account, login with your Google account <a href={login}> here </a>
							</div>: ""}
						{this.getPageComponent()}
					</div>

				</div>
			);
		}
	});

	return ApplicationComponent;
})