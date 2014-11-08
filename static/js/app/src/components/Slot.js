 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

'use strict'

define(["react", "app/trackdidia"], function(React, trackdidia){

	var ReactPropTypes = React.PropTypes;

	var SlotComponent = React.createClass({
		propTypes : {
			day : ReactPropTypes.object.isRequired,
			offset : ReactPropTypes.number.isRequired,
			duration: ReactPropTypes.number.isRequired

	    },
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {
			var slot = this.props.slot;
			var task = trackdidia.getTaskById(slot.task_id);
			console.log(task);

			return (
				<div className="row text-center">
					<p> <span><b> {task.name} </b></span> From <b>{this.props.start}</b> to <b>{this.props.finish}</b> </p>
					{task.description?<p>{task.description}</p>:""}
				</div>
				);
		}
	});

	return SlotComponent;
})