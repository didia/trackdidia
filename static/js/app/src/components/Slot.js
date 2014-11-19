 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

'use strict'

define(["react", "app/trackdidia", "app/TrackdidiaAction"], function(React, trackdidia, TrackdidiaAction){

	var ReactPropTypes = React.PropTypes;

	var SlotComponent = React.createClass({
		propTypes : {
			day : ReactPropTypes.object.isRequired,
			slot: ReactPropTypes.object.isRequired

	    },
		getInitialState : function() {
			return {
				showConfirmDelete:false
			};
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},
		_setExecuted : function() {
			TrackdidiaAction.setExecuted(this.props.slot);
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
				<div className="well">
					<div className="row">

						<div className = "col-xs-8">
							<p> <span><b> {task.name} </b></span> From <b>{this.props.start}</b> to <b>{this.props.finish}</b> </p>
							{task.description?<p>{task.description}</p>:""}
						</div>
						<div className = "col-xs-2">
							<input className = "input-lg" type ="checkbox" checked={checked} onChange = {this._setExecuted}/>
						</div>
						<div className = "col-xs-2">
							<a title = "Delete task" onClick = {this._toggleConfirmDelete} ><span className="glyphicon glyphicon-remove"> </span> </a>
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