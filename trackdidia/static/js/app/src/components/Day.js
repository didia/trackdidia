/** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["exports", "react", "components/Slot", "components/EmptySlot", "app/utils", "bootstrap"], function(exports, React, SlotComponent, EmptySlot, Utils){

	var ReactPropTypes = React.PropTypes;

	var DayComponent = React.createClass({

		propTypes : {
			day : ReactPropTypes.object.isRequired
	    },
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		createEmptySlot: function(offset, duration) {
			var startAndFinish = this.props.day.getStartAndFinishHour(offset, duration);
			var start = Utils.convertToHourString(startAndFinish[0]);
			var finish = Utils.convertToHourString(startAndFinish[1]);
			return <EmptySlot day = {this.props.day} key = {offset} start = {start} finish = {finish} offset = {offset} duration = {duration} />;
		},
		
		createSlot: function(slot) {
			var startAndFinish = this.props.day.getStartAndFinishHour(slot.offset, slot.duration);
			var start = Utils.convertToHourString(startAndFinish[0]);
			var finish = Utils.convertToHourString(startAndFinish[1]);
			return <SlotComponent day = {this.props.day} start = {start} finish = {finish} key = {slot.offset} slot = {slot} disabled = {!this.props.expanded} />
		},

		render: function() {

			var day = this.props.day;
			var day_id = day.id;
			var today_code = Utils.getTodayCode();
			var slots = [];
			var keys = [];
			var lastKey = -1;
			this.props.expanded = today_code == day_id;
			for (var key in day.scheduledTasks){
				keys.push(key);
			}

			keys.sort(function(a,b) { return a-b});
			var that = this;
			keys.forEach(function(key){
				if(key - lastKey != 1) {
					var offset = lastKey + 1;
					var duration = key - offset;
					slots.push(that.createEmptySlot(offset, duration));
				}
				
				slots.push(that.createSlot(day.scheduledTasks[key]));
				//last occupied key is offset + duration -1 because we don't count last end of interval is exclusive.
				lastKey = day.scheduledTasks[key].offset + day.scheduledTasks[key].duration - 1; 
		
			});
			if(lastKey != this.props.day.usage.length-1) {
				var offset = lastKey + 1;
				var duration = day.usage.length - offset;
				slots.push(this.createEmptySlot(offset, duration));
			}
			var heading_id = "heading-" + day_id;
			var body_id = "collapse-" + day_id;
			var panelClass = "panel panel-default day ";
			if(this.props.expanded)
				panelClass += "today"
			
			var dayName = Utils.getDayString(day_id);
			var numberOfTask = keys.length;
			var numberOfCompletedTask = day.getNumberOfCompletedTask();
			var percent = Math.round(day.stat[0] * 100 / day.stat[1]);
			var progressBarColor = "";
			if(percent < 50){
				progressBarColor = "progress-bar-danger";
			}
			else if(percent < 90) {
				progressBarColor = "progress-bar-warning";
			}
			else {
				progressBarColor = "progress-bar-success";
			}
			var progressBarClass = "progress-bar " + progressBarColor;
			var style = {
				width : percent +"%"
			}
	

			return (
				
			 	<div className={panelClass}>
			 		<a data-toggle="collapse" data-parent="#schedule" href={"#" + body_id } aria-expanded={this.props.expanded? "true": "false"} aria-controls={body_id}>
	    				<div className="panel-heading day-header" role="tab" id={heading_id}>
	    					<div className = "row">
	    						<div className = "col-xs-3">
		      						<h4 className="panel-title">
		        						<span> {dayName} </span> 
		      						</h4>
	      						</div>
	      						<div className = "col-xs-9">
		      						<div className = "progress">
		      							<div className = {progressBarClass} role="progress-bar" aria-valuenow = {percent} aria-valuemin = "0" aria-valuemax = "100" style={style}>
		      								{percent}%
		      							</div>
		      						</div>
	      						</div>
	      					</div>
	    				</div>
    				</a>
    				<div id={body_id} className={this.props.expanded? "panel-collapse collapse in":"panel-collapse collapse"} role="tabpanel" aria-labelledby={heading_id}>
      					<div className="panel-body day-body">
        					{slots}
                        </div>
                    </div>
  				</div>
			);
		}
	});

	return exports.DayComponent = DayComponent;
})