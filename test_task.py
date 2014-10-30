'''
Created on 2014-10-25

@author: didia
'''
import unittest
from base_test import DatastoreTest
import task
import user
from task import Task


class TestTask(DatastoreTest):

    def setUp(self):
        super(TestTask, self).setUp()
        self.user = user.create_user("101010", "thefuture2092@gmail.com", "didia")
    
    def test_to_dict_of_Task(self):
        name = "GLO-2100"
        my_task = Task(parent=self.user.key, name=name)
        key = my_task.put()
        task_dict = my_task.to_dict();
        self.assertEqual(key.integer_id(), task_dict.get("id"))
    

    
    def test_task_update(self):
        name = "GLO-2100"
        second_name = "GLO-2004"
        my_task = self.user.create_task(name = name)
        my_task.update(name = second_name)
        
        same_task = self.user.get_task(task_id = my_task.key.id())
        self.assertEqual(same_task.name, second_name)
         
        
        
    
        
        
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()