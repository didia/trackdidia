 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

'use strict'

define(["react", "app/trackdidia", "app/TrackdidiaAction", "app/event", "app/constants"], function(React, trackdidia, TrackdidiaAction, EventProvider, Constants){

	var ReactPropTypes = React.PropTypes;

	var SlotComponent = React.createClass({
		propTypes : {
			day : ReactPropTypes.object.isRequired,
			slot: ReactPropTypes.object.isRequired

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
		_setExecuted : function() {
			this.refs.executed.getDOMNode().checked = true;
			EventProvider.subscribe(Constants.SET_EXECUTED_FAILED, "_handleSetExecutedFailed", this);
			TrackdidiaAction.setExecuted(this.props.slot);
		},
		_handleSetExecutedFailed : function(message) {
			var state = this.state;
			state.errorMessage = message;
			this.refs.executed.getDOMNode().checked = false;
			EventProvider.unsubscribe(Constants.SET_EXECUTED_FAILED, "_handleSetExecutedFailed", this);
			this.setState(state);
		},
		_delete: function() {
			TrackdidiaAction.deleteSlot(this.props.day, this.props.slot);
		},
		_toggleConfirmDelete: function() {
			var state = this.state;
			state.showConfirmDelete = !state.showConfirmDelete;
			this.setState(state);
		},

		render: function() {
			var slot = this.props.slot;
			var task = trackdidia.getTaskById(slot.task_id);
			var checked = this.props.slot.executed?"checked":"";
			var classNameConfirmDelete = "row alert alert-danger alert-dismissible fade in ";
			if(!this.state.showConfirmDelete) {
				classNameConfirmDelete += "hidden";
			}

			return (
				<div className="slot">
					<div className="row">
						{this.state.errorMessage?
				  			<div className="alert alert-danger" role="alert">
				  				{ this.state.errorMessage}
				    		</div> : ""
				  		}
				  		<div className = "col-xs-3">
				  			<span><b> {this.props.start} - {this.props.finish} </b> </span>
				  		</div>
						<div className = "col-xs-7">
							<p> <span><b> {task.name} </b></span> </p>
							{task.description?<p>{task.description}</p>:""}
						</div>
						<div className = "horizontal-list col-xs-2 text-right">
							<ul>
								<li> <input className = "set-executed" type ="checkbox" ref = "executed" checked={checked} onChange = {this._setExecuted}/> </li>
								<li> <a title = "Delete task" onClick = {this._toggleConfirmDelete} ><span className="glyphicon glyphicon-remove"> </span> </a> </li>
							</ul>
						</div>
					</div>
					<div className={classNameConfirmDelete} role="alert">
				      <button type="button" className="close" onClick = {this._toggleConfirmDelete}><span aria-hidden="true">&times;</span><span className="sr-only">Close</span></button>
				      <h4>Are you sure?</h4>
				      <p>Are you sure you want to remove this task? This operation cannot be undone.</p>
				      <p>
				        <button type="button" onClick = {this._delete} className="btn btn-danger"> Remove this task </button>
				        <button type="button" onClick = {this._toggleConfirmDelete} className="btn btn-default"> Cancel </button>
				      </p>
					</div>
				</div>
				);
		}
	});

	return SlotComponent;
})