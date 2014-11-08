/** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Slot", "bootstrap"], function(React, SlotComponent){

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

		render: function() {

			var day = this.props.day;
			var slots = [];
			var keys = [];
			for (var key in day.slots){
				keys.push(key);
			}
			keys.sort(function(a,b) { return a-b});

			for (var key in keys) {
				slots.push(<SlotComponent key = {key} slot = {day.slots[key]}/>)
			}
			var heading_id = "heading-" + this.props.day.id;
			var body_id = "collapse-" + this.props.day.id;

			return (
				
			 	<div className="panel panel-default">
    				<div className="panel-heading" role="tab" id={heading_id}>
      					<h4 className="panel-title">
        					<a data-toggle="collapse" data-parent="#schedule" href={"#" + body_id } aria-expanded="false" aria-controls={body_id}>
          						Monday 3 september | Task : 18 | Completed : 5
        					</a>
      					</h4>
    				</div>
    				<div id={body_id} className="panel-collapse collapse" role="tabpanel" aria-labelledby={heading_id}>
      					<div className="panel-body">
        					{slots}
                        </div>
                    </div>
  				</div>
			);
		}
	});

	return DayComponent;
})