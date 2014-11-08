 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"user strict";

define(["react", "app/utils", "bootstrap"], function(React, Utils){
	var ReactPropTypes = React.PropTypes;
	var ScheduleTaskFormComponent = React.createClass({

		propTypes : {
			day : ReactPropTypes.object.isRequired,
			tasks:ReactPropTypes.object.isRequired,
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
		_handleSubmit : function() {

		},
		
		render: function() {
			var timeOptions = [];
			var tasksOptions =[];
			var day = this.props.day;
			var endOffset = this.props.offset + this.props.duration;
			var startDefaultOption = <option value = {this.props.offset} selected>{Utils.convertToHourString(day.getHourFromOffset(this.props.offset))} </option>
			var endDefaultOption = <option value = {endOffset} selected>{Utils.convertToHourString(day.getHourFromOffset(endOffset))}</option>
			for(var i = this.props.offset + 1; i < endOffset; i++) {
				timeString = Utils.convertToHourString(day.getHourFromOffset(i));
				timeOptions.push(<option value = {i}> {timeString} </option>)
			}

			for(var key in this.props.tasks) {
				tasksOptions.push(<option value = {key}> {this.props.tasks[key].name} </option>);
			}
			return (
				<form className="form-horizontal" role = "form" >
				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "starting-input"> Start Time </label>
					<div className = "col-sm-10">
						<select className = "form-control" name = "starting" id = "starting-input" required>
							{startDefaultOption}
							{timeOptions}
						</select>
					</div>
				  </div>

				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "ending-input"> End Time </label>
					<div className = "col-sm-10">
						<select className = "form-control" name = "offset" id = "ending-input" required>
							{timeOptions}
							{endDefaultOption}
						</select>
					</div>
				  </div>

				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "task-input"> Exisiting Task </label>
					<div className = "col-sm-10">
						<select className = "form-control" name = "task_id" id = "task-input">
							<option value=""> Choose an existing task </option>
							{tasksOptions}
						</select>
					</div>
				  </div>

				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "name-input"> Task Name </label>
					<div className = "col-sm-10">
						<input className = "form-control" name = "name" id = "name-input" />
					</div>
				  </div>

				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "description-input"> Description </label>
					<div className = "col-sm-10">
						<input className = "form-control" name = "description" id = "description-input" />
					</div>
				  </div>

				  <div className = "form-group">
				    <label className = "control-label col-sm-2" for = "location-input"> Location </label>
					<div className = "col-sm-10">
						<input className = "form-control" name = "location" id = "location-input" />
					</div>
				  </div>

				  <div className = "form-group">
				  	<div className = "col-sm-10">
				  		<button type = "submit" className = "btn btn-default" onClick = {this._handleSubmit}> Add </button>
				  	</div>
				  </div>

				</form>

				);
		}
	});

	return ScheduleTaskFormComponent;
})