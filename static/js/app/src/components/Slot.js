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
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},
		_setExecuted : function() {
			TrackdidiaAction.setExecuted(this.props.slot);
		},

		render: function() {
			var slot = this.props.slot;
			var task = trackdidia.getTaskById(slot.task_id);
			var checked = this.props.slot.executed?"checked":"";

			return (
				<div className="row well">
					<div className = "col-sm-10">
						<p> <span><b> {task.name} </b></span> From <b>{this.props.start}</b> to <b>{this.props.finish}</b> </p>
						{task.description?<p>{task.description}</p>:""}
					</div>
					<div className = "col-sm-2">
						<input type ="checkbox" checked={checked} onChange = {this._setExecuted}/>
					</div>
				</div>
				);
		}
	});

	return SlotComponent;
})