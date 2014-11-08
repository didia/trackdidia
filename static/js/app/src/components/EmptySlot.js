 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"user strict";

define(["react", "components/ScheduleTaskForm", "app/trackdidia", "bootstrap"], function(React, ScheduleForm, trackdidia){
	var ReactPropTypes = React.PropTypes;


	var EmptySlotComponent = React.createClass({

		propTypes : {
			day : ReactPropTypes.object.isRequired,
			offset : ReactPropTypes.number.isRequired,
			duration: ReactPropTypes.number.isRequired

	    },
		getInitialState : function() {
			return {
				isEditing: false
			};
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},
		_showCreateTaskForm: function() {
			this.setState({isEditing:true});
		},

		render: function() {
			var content = '';
			if(this.state.isEditing) {
				var tasks = trackdidia.getAllTasks();
				content = <ScheduleForm day={this.props.day} offset = {this.props.offset} duration = {this.props.duration} tasks = {tasks} />;
			}
			else {

			}
			return (
				<div className = "row text-center">
					{this.state.isEditing?content:
						<div>
							<p> Nothing from <b>{this.props.start}</b> to <b>{this.props.finish}</b></p>
							<button className="btn btn-primary" onClick={this._showCreateTaskForm}> Schedule a task </button>
						</div>
					}
					
				</div>

				);
		}
	});

	return EmptySlotComponent;
})