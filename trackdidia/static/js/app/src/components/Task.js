/** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["exports", "react", "app/utils", "app/event" ,"app/constants", "app/TrackdidiaAction", "bootstrap"], function(exports, React, Utils, EventProvider, Constants, TrackdidiaAction){

	var ReactPropTypes = React.PropTypes;

	var TaskComponent = React.createClass({
		propTypes : {
			task : ReactPropTypes.object.isRequired

	    },
		getInitialState : function() {
			return {
				showConfirmDelete:false,
				errorMessage: null
			};
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		_handleDeleteFailed : function(message) {
			var state = this.state;
			state.errorMessage = "Task deletion failed : " + message;
			state.showConfirmDelete = false;
			this.refs.force.getDOMNode().checked = false;
			EventProvider.unsubscribe(Constants.DELETE_TASK_FAILED, "_handleDeleteFailed", this);
			this.setState(state);
		},
		_delete: function() {
			var force = this.refs.force.getDOMNode().checked;
			EventProvider.subscribe(Constants.DELETE_TASK_FAILED, "_handleDeleteFailed", this);
			TrackdidiaAction.deleteTask(this.props.task, force);
		},
		_toggleConfirmDelete: function() {
			var state = this.state;
			state.showConfirmDelete = !state.showConfirmDelete;
			this.setState(state);
		},
		_deleteErrorMessage : function() {
			var state = this.state;
			state.errorMessage = null;
			this.setState(state);
		},
		render: function() {
			
			var task = this.props.task;

			var classNameConfirmDelete = "row alert alert-danger alert-dismissible fade in ";
			if(!this.state.showConfirmDelete) {
				classNameConfirmDelete += "hidden";
			}

			return (
				
				<div className="slot">
					<div className="row">
						<div className = "col-xs-10">
							<p> <span><b> {task.name} </b></span> </p>
							{task.description?<p>{task.description}</p>:""}
						</div>
						<div className = "horizontal-list col-xs-2 text-right">
							<ul>
								<li> <a title = "Delete task" onClick = {this._toggleConfirmDelete} onTouchEnd = {this._toggleConfirmDelete} ><span className="glyphicon glyphicon-remove"> </span> </a> </li>
							</ul>
						</div>
					</div>
					{this.state.errorMessage?
			  			<div className="alert alert-danger" role="alert">
			  				<button type="button" className="close" onClick = {this._deleteErrorMessage} onTouchEnd = {this._deleteErrorMessage} ><span aria-hidden="true">&times;</span><span className="sr-only">Close</span></button>
			  				<p>{ this.state.errorMessage}</p>
			    		</div> : ""
				  	}
					<div className={classNameConfirmDelete} role="alert">
				      <button type="button" className="close" onClick = {this._toggleConfirmDelete} onTouchEnd = {this._toggleConfirmDelete} ><span aria-hidden="true">&times;</span><span className="sr-only">Close</span></button>
				      <h4>Are you sure?</h4>
				      <p>Are you sure you want to remove this task? This operation cannot be undone.</p>
				      {true?<p><input type = "checkbox" ref = "force" /> Delete even even if there are scheduled tasks associated to this task. This will also delete all future scheduled tasks associated to this task </p> : ""}
				      <p>
				        <button type="button" onClick = {this._delete} onTouchEnd = {this._delete} className="btn btn-danger"> Remove this task </button>
				        <button type="button" onClick = {this._toggleConfirmDelete} onTouchEnd = {this._toggleConfirmDelete} className="btn btn-default"> Cancel </button>
				      </p>
					</div>
				</div>
			);
		}
	});

	return exports.TaskComponent = TaskComponent;
})